import ExcelJS from 'exceljs';
import type { PaymentWithRelations } from '@/hooks/usePayments';

interface BulkPaymentSummary {
  contractId: string;
  customerName: string;
  contractRef: string;
  paymentCount: number;
  totalCoupons: number;
  dailyAmount: number;
  totalAmount: number;
}

const HEADERS = [
  'No', 'Konsumen', 'Kode Kontrak', 'Jumlah Pembayaran', 'Jumlah Kupon', 'Angsuran', 'Total Tertagih (Rp)'
];

const COL_WIDTHS = [5, 30, 16, 16, 12, 14, 18];

export const exportPaymentInputToExcel = async (payments: PaymentWithRelations[], contracts: any[]) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Management System Kredit';
  workbook.created = new Date();

  // Create main sheet
  const sheet = workbook.addWorksheet('Input Pembayaran');

  // Title
  sheet.mergeCells('A1:G1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = 'LAPORAN INPUT PEMBAYARAN (BULK)';
  titleCell.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  titleCell.alignment = { horizontal: 'center' };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };

  // Date info
  sheet.mergeCells('A2:G2');
  const dateCell = sheet.getCell('A2');
  dateCell.value = `Per tanggal: ${new Date().toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' })}`;
  dateCell.font = { italic: true, size: 12 };
  dateCell.alignment = { horizontal: 'center' };

  sheet.addRow([]);

  // Headers
  const hRow = sheet.addRow(HEADERS);
  hRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF70AD47' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
  });

  const startRow = hRow.number + 1;

  // Build bulk summary from payments grouped by contract
  const bulkMap = new Map<string, BulkPaymentSummary>();

  payments.forEach((payment) => {
    const contract = contracts.find(c => c.id === payment.contract_id);
    const dailyAmount = contract?.daily_installment_amount || 0;
    const customerName = payment.credit_contracts?.customers?.name || '-';
    const contractRef = payment.credit_contracts?.contract_ref || '-';

    const key = payment.contract_id;
    if (!bulkMap.has(key)) {
      bulkMap.set(key, {
        contractId: payment.contract_id,
        customerName,
        contractRef,
        paymentCount: 0,
        totalCoupons: 0,
        dailyAmount,
        totalAmount: 0,
      });
    }

    const summary = bulkMap.get(key)!;
    summary.paymentCount += 1;
    summary.totalCoupons += 1; // 1 pembayaran = 1 kupon
    summary.totalAmount += dailyAmount;
  });

  // Convert map to array and sort
  const bulkData = Array.from(bulkMap.values()).sort((a, b) => 
    a.contractRef.localeCompare(b.contractRef)
  );

  // Build rows from bulk summary
  bulkData.forEach((bulk, i) => {
    const dataRowValues = [
      i + 1,
      bulk.customerName,
      bulk.contractRef,
      bulk.paymentCount,
      bulk.totalCoupons,
      bulk.dailyAmount,
      bulk.totalAmount,
    ];

    const dataRow = sheet.addRow(dataRowValues);

    dataRow.eachCell((cell, colNumber) => {
      cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };

      // Format numeric and currency columns
      if ([4, 5].includes(colNumber)) {
        cell.numFmt = '#,##0';
        cell.alignment = { horizontal: 'center' };
      } else if ([6, 7].includes(colNumber)) {
        cell.numFmt = '"Rp "#,##0';
        cell.alignment = { horizontal: 'right' };
      }
    });
  });

  // Total row
  if (bulkData.length > 0) {
    const endRow = startRow + bulkData.length - 1;
    const totalRowValues = [
      '', '', 'TOTAL', '', '',
      { formula: `SUM(F${startRow}:F${endRow})` },
      { formula: `SUM(G${startRow}:G${endRow})` },
    ];

    const totalRow = sheet.addRow(totalRowValues);

    totalRow.eachCell((cell, colNumber) => {
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E2F3' } };
      cell.border = { top: { style: 'double' }, bottom: { style: 'double' }, left: { style: 'thin' }, right: { style: 'thin' } };
      
      if ([4, 5].includes(colNumber)) {
        cell.numFmt = '#,##0';
        cell.alignment = { horizontal: 'center' };
      } else if ([6, 7].includes(colNumber)) {
        cell.numFmt = '"Rp "#,##0';
        cell.alignment = { horizontal: 'right' };
      }
    });
  }

  // Column widths
  sheet.columns = COL_WIDTHS.map((width) => ({ width }));

  // Download
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Input_Pembayaran_${new Date().toISOString().split('T')[0]}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
};
