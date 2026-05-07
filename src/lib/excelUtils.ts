import ExcelJS from 'exceljs';

export function autoResizeSheetColumns(sheet: ExcelJS.Worksheet, minWidths: number[] = [], maxWidth = 40, skipRows = 3) {
  // skipRows: number of top rows to ignore when measuring (titles, date lines, etc.)
  const colCount = Math.max(sheet.columnCount, minWidths.length);
  const measured: number[] = Array.from({ length: colCount }, (_, i) => minWidths[i] || 8);
  const currencyFormatter = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 });

  sheet.eachRow({ includeEmpty: true }, (row) => {
    if (row.number <= skipRows) return; // ignore title/date rows which are often merged and long
    row.eachCell({ includeEmpty: true }, (cell, colNum) => {
      let text = '';
      const v: any = cell.value;
      if (v == null) {
        text = '';
      } else if (typeof v === 'object') {
        if ('richText' in v && Array.isArray(v.richText)) {
          text = v.richText.map((r: any) => r.text).join('');
        } else if ('formula' in v) {
          if (v.result != null) {
            text = typeof v.result === 'number' && cell.numFmt && String(cell.numFmt).includes('Rp') ? currencyFormatter.format(v.result) : String(v.result);
          } else {
            text = String(v.formula || '');
          }
        } else if ('text' in v) {
          text = String(v.text);
        } else {
          text = JSON.stringify(v);
        }
      } else if (typeof v === 'number') {
        if (cell.numFmt && String(cell.numFmt).includes('Rp')) text = currencyFormatter.format(v);
        else text = String(v);
      } else {
        text = String(v);
      }

      const len = Math.min(maxWidth, Math.max(0, text.length));
      // add a small padding so values don't touch cell borders
      measured[colNum - 1] = Math.max(measured[colNum - 1] || 0, Math.min(maxWidth, len + 2));
    });
  });

  sheet.columns = Array.from({ length: colCount }, (_, i) => {
    const min = minWidths[i] || 8;
    const w = Math.max(min, Math.min(maxWidth, measured[i] || min));
    return { width: w };
  });
}
