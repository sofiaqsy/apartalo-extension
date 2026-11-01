/**
 * BCP -> Apartalo  +  Dashboard de Proceso Cafe
 *
 * CAMBIOS respecto a la versión anterior (sólo doPost / doGet y helpers):
 *  - Un pedido de BCP se considera repetido si su Nº de operación YA ESTÁ en
 *    la columna G de la hoja, comparado sin ceros a la izquierda
 *    ("06055535" de BCP == 6055535 en la hoja). Antes se comparaba texto contra
 *    número y nunca coincidía.
 *  - Se lee la hoja completa con getValues(), que ignora los filtros.
 *  - doGet() devuelve las operaciones que ya existen, para que la extensión
 *    envíe sólo lo que falta.
 *  - Las filas nuevas se muestran aunque haya un filtro activo.
 *  - La respuesta incluye {saved, added, skipped}.
 *
 * onOpen, openDashboard y getDashboardData NO cambian.
 *
 * Despliegue: Implementar > Administrar implementaciones > Editar (lápiz)
 *             > Versión: "Nueva versión" > Implementar. La URL /exec no cambia.
 */

// ── Helpers de deduplicación ────────────────────────────────────────────────

/** "02108000" -> "2108000". Vacío, 0, "00000000" -> "" (fila sin operación). */
function normOp_(v) {
  return String(v == null ? '' : v).replace(/\D/g, '').replace(/^0+/, '');
}

/** Date de la hoja o texto "d/m/yyyy" del BCP -> "dd/mm/yyyy". */
function fechaKey_(v, tz) {
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, tz, 'dd/MM/yyyy');
  const m = String(v == null ? '' : v).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m
    ? ('0' + m[1]).slice(-2) + '/' + ('0' + m[2]).slice(-2) + '/' + m[3]
    : String(v == null ? '' : v).trim();
}

/** Para filas sin Nº de operación (p. ej. ITF): fecha + monto + descripción. */
function fallbackKey_(fecha, monto, desc, tz) {
  return fechaKey_(fecha, tz) + '|' + Number(monto) + '|' + String(desc == null ? '' : desc).trim();
}

/** Lee TODA la hoja (incluye filas ocultas por un filtro). */
function readExisting_(sheet, tz) {
  const ops = {}, fallbacks = {}, blank = {};
  const last = sheet.getLastRow();
  if (last > 1) {
    sheet.getRange(2, 1, last - 1, 8).getValues().forEach(function (r) {
      const op = normOp_(r[6]);
      if (op) {
        ops[op] = true;
        // Ingreso con la columna H vacía: aún sin cliente ni pedido asignado.
        if (String(r[1]).trim() === 'Ingreso' && String(r[7] == null ? '' : r[7]).trim() === '') blank[op] = true;
      } else fallbacks[fallbackKey_(r[0], r[3], r[4], tz)] = true;
    });
  }
  return { ops: ops, fallbacks: fallbacks, blank: blank };
}

function getIncomeOutcomeSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Income-Outcome');
  if (!sheet) sheet = ss.insertSheet('Income-Outcome');
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Fecha','Tipo','Categoría','Monto','Descripción','Cuenta','Op. BCP','Pedido']);
  }
  return { ss: ss, sheet: sheet };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Cliente y pedido en la columna H de un ingreso validado ─────────────────
// La extensión avisa cuando valida una transferencia contra un pedido; aquí se
// deja "Cliente · ORD-..." en la columna H de esa fila. Igual que la
// conciliación de gastos: SÓLO si la columna H está vacía (nunca se pisa texto).
function assignPedidos_(items) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = getIncomeOutcomeSheet_().sheet;
    const out = { ok: true, assigned: 0, already: 0, skipped: 0, notFound: 0 };
    const last = sheet.getLastRow();
    if (last < 2) { out.notFound = items.length; return out; }

    // getValues lee también las filas ocultas por un filtro.
    const data = sheet.getRange(2, 1, last - 1, 8).getValues();
    const byOp = {};
    data.forEach(function (r, i) {
      const op = normOp_(r[6]);
      if (op) (byOp[op] = byOp[op] || []).push(i);
    });

    items.forEach(function (it) {
      const op = normOp_(it.operacion), texto = String(it.texto || '').trim();
      const idxs = byOp[op];
      if (!op || !texto || !idxs) { out.notFound++; return; }
      idxs.forEach(function (i) {
        const actual = String(data[i][7] == null ? '' : data[i][7]).trim();
        if (actual === '') {
          sheet.getRange(i + 2, 8).setValue(texto);
          data[i][7] = texto;
          out.assigned++;
        } else if (actual === texto) {
          out.already++;
        } else {
          out.skipped++;      // ya tiene otro texto: se respeta
        }
      });
    });
    return out;
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    lock.releaseLock();
  }
}

// ── Endpoints de la extensión ───────────────────────────────────────────────

/** GET: qué operaciones ya tiene la hoja. La extensión filtra con esto. */
function doGet() {
  try {
    const h = getIncomeOutcomeSheet_();
    const ex = readExisting_(h.sheet, h.ss.getSpreadsheetTimeZone());
    return json_({ ok: true, ops: Object.keys(ex.ops), fallbacks: Object.keys(ex.fallbacks),
                   blankIncomes: Object.keys(ex.blank), features: ['assign'] });
  } catch (err) {
    return json_({ ok: false, error: err.message });
  }
}

/** POST: agrega sólo las filas cuyo Nº de operación NO está ya en la hoja. */
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const data = JSON.parse(e.postData.contents);
    if (data && !Array.isArray(data) && data.action === 'assign') {
      return json_(assignPedidos_(data.items || []));
    }
    const h = getIncomeOutcomeSheet_();
    const sheet = h.sheet;
    const tz = h.ss.getSpreadsheetTimeZone();
    const ex = readExisting_(sheet, tz);

    const rows = Array.isArray(data) ? data : [data];
    const firstNewRow = sheet.getLastRow() + 1;
    let saved = 0;

    rows.forEach(function (r) {
      const op = normOp_(r.operacion);
      const fb = fallbackKey_(r.fecha, r.monto, r.descripcion, tz);
      if (op ? ex.ops[op] : ex.fallbacks[fb]) return;           // ya estaba
      // Mismo formato que antes: la fecha viaja como texto y Sheets la interpreta.
      sheet.appendRow([r.fecha, r.tipo, r.categoria, r.monto, r.descripcion,
                       r.cuenta || 'BCP', r.operacion || '', r.pedido || '']);
      if (op) ex.ops[op] = true; else ex.fallbacks[fb] = true;   // también dentro del mismo lote
      saved++;
    });

    if (saved > 0) {
      // Un filtro activo oculta las filas nuevas que no cumplan su criterio:
      // se muestran para que no parezca que no se agregaron.
      try { sheet.showRows(firstNewRow, saved); } catch (_) {}
    }

    let rec = { filled: 0, linked: 0 };
    try { rec = reconcile_(true); } catch (e2) { rec = { filled: 0, linked: 0, error: e2.message }; }

    return json_({ ok: true, saved: saved, added: saved, skipped: rows.length - saved,
                   reconciled: rec.filled, linked: rec.linked, reconcileError: rec.error || null });
  } catch (err) {
    return json_({ ok: false, error: err.message });
  } finally {
    lock.releaseLock();
  }
}

// ── Conciliación con las pestañas Gastos, Compras y Adelantos ───────────────
// Después de agregar filas del BCP, copia a Income-Outcome la categoría (col C)
// y la descripción (col H) que ya registraste a mano en Gastos o Compras.
// Sólo lee el mes actual (más unos días atrás, para subidas a inicio de mes).
//
//  Gastos : A fecha | B concepto (= categoría) | C monto | D Nº operación | E notas
//  Compras: B fecha | D proveedor | G preciototal | K op_bcp (se crea sola)
//  Adelantos: A fecha | C proveedor | D monto | J op_bcp (se crea sola)

const DIAS_TOLERANCIA   = 3;    // diferencia máxima de fecha entre el BCP y tu registro
const TOLERANCIA_COMPRAS = 1.0; // preciototal trae céntimos; el BCP se paga redondeado
const DIAS_ATRAS        = 5;    // ventana: desde el día 1 del mes menos estos días

function findSheet_(ss, name) {
  const want = name.toLowerCase();
  return ss.getSheets().filter(function (s) { return s.getName().trim().toLowerCase() === want; })[0] || null;
}

function dayNum_(y, m, d) { return Math.floor(Date.UTC(y, m - 1, d) / 86400000); }

/** Date de la hoja o texto "YYYY-MM-DD ..." / "d/m/yyyy" -> nº de día, o null. */
function toDay_(v, tz) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    const p = Utilities.formatDate(v, tz, 'yyyy-MM-dd').split('-');
    return dayNum_(+p[0], +p[1], +p[2]);
  }
  const s = String(v == null ? '' : v).trim().replace(/^'/, '');
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return dayNum_(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? dayNum_(+m[3], +m[2], +m[1]) : null;
}

/** Montos como número o como texto ("50.0", "1891.50"). */
function toAmount_(v) {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}

/** Sólo cuenta como Nº de operación si la celda es puramente numérica. */
function linkedOp_(v) {
  return /^\s*\d+\s*$/.test(String(v == null ? '' : v)) ? normOp_(v) : '';
}

function readGastos_(ss, tz, minDay) {
  const sh = findSheet_(ss, 'Gastos');
  const items = [];
  if (!sh || sh.getLastRow() < 2) return items;
  const last = sh.getLastRow(), first = Math.max(2, last - 399);
  sh.getRange(first, 1, last - first + 1, 5).getValues().forEach(function (r, i) {
    const day = toDay_(r[0], tz), monto = toAmount_(r[2]);
    if (day == null || monto == null || day < minDay) return;
    const cat = String(r[1] || '').trim();
    items.push({ kind: 'Gastos', sheet: sh, row: first + i, col: 4, day: day, monto: monto,
      categoria: cat, nota: String(r[4] || '').trim() || cat,
      op: linkedOp_(r[3]), writable: String(r[3] == null ? '' : r[3]).trim() === '' });
  });
  return items;
}

function readCompras_(ss, tz, minDay) {
  const sh = findSheet_(ss, 'Compras');
  const items = [];
  if (!sh || sh.getLastRow() < 2) return items;
  const last = sh.getLastRow(), first = Math.max(2, last - 149);
  sh.getRange(first, 1, last - first + 1, 11).getValues().forEach(function (r, i) {
    const day = toDay_(r[1], tz), monto = toAmount_(r[6]);
    if (day == null || monto == null || day < minDay) return;
    items.push({ kind: 'Compras', sheet: sh, row: first + i, col: 11, day: day, monto: monto,
      categoria: 'Compra', nota: 'Compra de cafe ' + String(r[3] || '').trim(),
      op: linkedOp_(r[10]), writable: String(r[10] == null ? '' : r[10]).trim() === '' });
  });
  return items;
}

function readAdelantos_(ss, tz, minDay) {
  const sh = findSheet_(ss, 'adelantos');
  const items = [];
  if (!sh || sh.getLastRow() < 2) return items;
  const last = sh.getLastRow(), first = Math.max(2, last - 149);
  // A fecha | B hora | C proveedor | D monto | ... | J op_bcp (se crea sola)
  sh.getRange(first, 1, last - first + 1, 10).getValues().forEach(function (r, i) {
    const day = toDay_(r[0], tz), monto = toAmount_(r[3]);
    if (day == null || monto == null || day < minDay) return;
    const prov = String(r[2] || '').trim();
    // La categoría pasa a "Adelantos", igual que las compras pasan a "Compra".
    items.push({ kind: 'Adelantos', sheet: sh, row: first + i, col: 10, day: day, monto: monto,
      categoria: 'Adelantos', nota: 'Adelanto a compra ' + prov,
      op: linkedOp_(r[9]), writable: String(r[9] == null ? '' : r[9]).trim() === '' });
  });
  return items;
}

/**
 * Empareja cada gasto del BCP con UNA entrada de Gastos, Compras o Adelantos y rellena
 * categoría y descripción SÓLO en las filas cuya columna H está vacía.
 * apply=false sólo calcula (vista previa). now es opcional (para pruebas).
 */
function reconcile_(apply, now) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = ss.getSpreadsheetTimeZone();
  const io = ss.getSheetByName('Income-Outcome');
  const out = { filled: 0, linked: 0, lines: [] };
  if (!io || io.getLastRow() < 2) return out;

  const p = Utilities.formatDate(now || new Date(), tz, 'yyyy-MM-dd').split('-');
  const minDay = dayNum_(+p[0], +p[1], 1) - DIAS_ATRAS;

  const last = io.getLastRow(), first = Math.max(2, last - 299);
  const bcp = [];
  io.getRange(first, 1, last - first + 1, 8).getValues().forEach(function (r, i) {
    if (String(r[1]).trim() !== 'Gasto') return;
    const day = toDay_(r[0], tz), monto = toAmount_(r[3]), op = normOp_(r[6]);
    if (!op || day == null || monto == null || day < minDay) return;   // ITF y similares: sin operación
    bcp.push({ row: first + i, day: day, monto: monto, op: op,
               described: String(r[7] == null ? '' : r[7]).trim() !== '' });
  });

  const entries = readGastos_(ss, tz, minDay).concat(readCompras_(ss, tz, minDay)).concat(readAdelantos_(ss, tz, minDay));
  const usedE = {}, usedB = {}, pairs = [];
  const idx = function (e) { return e.kind + e.row; };

  // 1) Vínculo exacto: la entrada ya trae el Nº de operación.
  bcp.forEach(function (b) {
    const e = entries.filter(function (x) { return x.op === b.op && !usedE[idx(x)]; })[0];
    if (e) { usedE[idx(e)] = usedB[b.row] = true; pairs.push({ b: b, e: e }); }
  });

  // 2) Por monto y fecha. Un candidato por cada par posible; se asigna el mejor primero.
  const cands = [];
  bcp.forEach(function (b) {
    if (usedB[b.row]) return;
    entries.forEach(function (e) {
      if (e.op || usedE[idx(e)]) return;                    // ya vinculada a otra operación
      const dAmt = Math.abs(b.monto - e.monto), dDay = Math.abs(b.day - e.day);
      const okAmt = e.kind === 'Compras' ? dAmt <= TOLERANCIA_COMPRAS : dAmt < 0.005;
      if (!okAmt || dDay > DIAS_TOLERANCIA) return;
      cands.push({ b: b, e: e, exact: dAmt < 0.005 ? 0 : 1, dDay: dDay, dAmt: dAmt });
    });
  });
  cands.sort(function (x, y) {
    return x.exact - y.exact || x.dDay - y.dDay || x.dAmt - y.dAmt || x.b.row - y.b.row || x.e.row - y.e.row;
  });
  cands.forEach(function (c) {
    if (usedB[c.b.row] || usedE[idx(c.e)]) return;
    usedB[c.b.row] = usedE[idx(c.e)] = true;
    pairs.push({ b: c.b, e: c.e });
  });

  // 3) Aplicar. SÓLO si la columna H de la fila está vacía. Una fila con texto en H
  //    no se toca en absoluto (ni Income-Outcome ni Gastos/Compras): en el paso 2
  //    sólo reservó su entrada en memoria, para que otro pago no se la lleve.
  pairs.forEach(function (pr) {
    const fill = !pr.b.described;
    if (!fill) return;
    const link = pr.e.writable;
    if (apply) {
      if (fill) {
        if (pr.e.categoria != null) io.getRange(pr.b.row, 3).setValue(pr.e.categoria);
        io.getRange(pr.b.row, 8).setValue(pr.e.nota);
      }
      if (link) {
        if (pr.e.kind !== 'Gastos' && !String(pr.e.sheet.getRange(1, pr.e.col).getValue()).trim()) {
          pr.e.sheet.getRange(1, pr.e.col).setValue('op_bcp');
        }
        pr.e.sheet.getRange(pr.e.row, pr.e.col).setValue(Number(pr.b.op));
      }
    }
    out.filled++;
    if (link) out.linked++;
    out.lines.push('Fila ' + pr.b.row + '  S/ ' + pr.b.monto + '  ->  ' + (pr.e.categoria || '(categoría sin cambio)') + ' · ' + pr.e.nota +
                   '  (' + pr.e.kind + ' fila ' + pr.e.row + ')');
  });
  return out;
}

function showReconcile_(apply) {
  const r = reconcile_(apply);
  const ui = SpreadsheetApp.getUi();
  const body = r.lines.length
    ? r.lines.slice(0, 25).join('\n') + (r.lines.length > 25 ? '\n... y ' + (r.lines.length - 25) + ' más' : '')
    : 'No hay nada nuevo por conciliar este mes.';
  ui.alert(apply ? 'Conciliación aplicada (' + r.filled + ' filas)' : 'Vista previa: no se escribió nada', body, ui.ButtonSet.OK);
}
function conciliarVistaPrevia() { showReconcile_(false); }
function conciliarMenu()        { showReconcile_(true); }

// ── Dashboard (sin cambios) ─────────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📊 Dashboard')
    .addItem('Abrir Dashboard', 'openDashboard')
    .addSeparator()
    .addItem('Conciliar gastos, compras y adelantos', 'conciliarMenu')
    .addItem('Conciliar: vista previa', 'conciliarVistaPrevia')
    .addToUi();
}


function openDashboard() {
  const html = HtmlService
    .createHtmlOutputFromFile('dashboard')
    .setTitle('Proceso Cafe · Ingresos & Gastos')
    .setWidth(420);

  SpreadsheetApp.getUi().showSidebar(html);
}


/**
 * Returns all transactions from the Income-Outcome sheet.
 */
function getDashboardData() {

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

  const sheet = spreadsheet.getSheetByName('Income-Outcome');

  if (!sheet) {
    throw new Error(
      'No se encontró la hoja "Income-Outcome".'
    );
  }

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return [];
  }


  /*
   * IMPORTANT:
   *
   * Use the timezone configured in the
   * Google Spreadsheet.
   *
   * Do NOT force America/Lima here.
   *
   * This prevents dates such as:
   *
   * 01/08/2026
   *
   * from accidentally becoming:
   *
   * 31/07/2026
   */
  const timezone =
    spreadsheet.getSpreadsheetTimeZone();


  const values = sheet
    .getRange(
      2,
      1,
      lastRow - 1,
      8
    )
    .getValues();


  const result = [];


  values.forEach((row, index) => {

    const sheetRow = index + 2;


    /*
     * Ignore completely empty rows.
     */
    if (
      !row[0] ||
      row[3] === '' ||
      row[3] === null
    ) {
      return;
    }


    let fecha;


    try {

      fecha = Utilities.formatDate(
        new Date(row[0]),
        timezone,
        'yyyy-MM-dd'
      );

    } catch (error) {

      console.log(
        'Error procesando fecha en fila ' +
        sheetRow +
        ': ' +
        error.message
      );

      return;
    }


    result.push({

      sheetRow: sheetRow,

      fecha: fecha,

      tipo: String(
        row[1] || ''
      ).trim(),

      categoria: String(
        row[2] || ''
      ).trim(),

      monto: Number(
        row[3]
      ) || 0,

      descripcion: String(
        row[4] || ''
      ).trim(),

      cuenta: String(
        row[5] || ''
      ).trim(),

      operacion: String(
        row[6] || ''
      ).trim()

    });

  });


  /*
   * Debug information.
   */
  console.log(
    'Spreadsheet timezone:',
    timezone
  );

  console.log(
    'Last row:',
    lastRow
  );

  console.log(
    'Rows returned:',
    result.length
  );


  const row86 = result.find(
    row => row.sheetRow === 86
  );


  console.log(
    'Row 86:',
    JSON.stringify(row86)
  );


  return result;
}
