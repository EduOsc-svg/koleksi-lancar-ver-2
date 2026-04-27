import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { format, startOfMonth, endOfMonth, startOfYear, endOfYear } from 'date-fns';

/**
 * Hitung kerugian dari kontrak yang di-return / macet permanen.
 * Kerugian = Modal yang sudah dikeluarkan - Uang yang sempat tertagih (dari kontrak tsb).
 */
export interface ReturnedLossSummary {
  total_modal_loss: number;       // total modal yang ditanam pada kontrak return
  total_collected_back: number;    // total uang yg sempat tertagih dari kontrak return
  total_loss: number;              // modal - tertagih (kerugian bersih)
  returned_count: number;          // jumlah kontrak return
}

const fetchReturnedLoss = async (rangeStart: string, rangeEnd: string): Promise<ReturnedLossSummary> => {
  const { data: returnedContracts, error: cErr } = await supabase
    .from('credit_contracts')
    .select('id, omset, total_loan_amount, start_date, status')
    .eq('status', 'returned')
    .gte('start_date', rangeStart)
    .lte('start_date', rangeEnd);
  if (cErr) throw cErr;

  const ids = (returnedContracts || []).map((c: any) => c.id);
  const collectedMap = new Map<string, number>();
  if (ids.length > 0) {
    const { data: payments, error: pErr } = await supabase
      .from('payment_logs')
      .select('contract_id, amount_paid')
      .in('contract_id', ids);
    if (pErr) throw pErr;
    (payments || []).forEach((p: any) => {
      collectedMap.set(p.contract_id, (collectedMap.get(p.contract_id) || 0) + Number(p.amount_paid || 0));
    });
  }

  let total_modal_loss = 0;
  let total_collected_back = 0;
  (returnedContracts || []).forEach((c: any) => {
    total_modal_loss += Number(c.omset || 0);
    total_collected_back += collectedMap.get(c.id) || 0;
  });
  const total_loss = Math.max(0, total_modal_loss - total_collected_back);

  return {
    total_modal_loss,
    total_collected_back,
    total_loss,
    returned_count: (returnedContracts || []).length,
  };
};

/** Scope: kontrak return di bulan terpilih (start_date dalam bulan tsb). */
export const useReturnedLoss = (month: Date = new Date()) => {
  const monthStart = format(startOfMonth(month), 'yyyy-MM-dd');
  const monthEnd = format(endOfMonth(month), 'yyyy-MM-dd');

  return useQuery({
    queryKey: ['returned_loss', monthStart, monthEnd],
    queryFn: () => fetchReturnedLoss(monthStart, monthEnd),
  });
};

/** Scope: kontrak return di tahun terpilih (start_date dalam tahun tsb). */
export const useReturnedLossYearly = (year: Date = new Date()) => {
  const yearStart = format(startOfYear(year), 'yyyy-MM-dd');
  const yearEnd = format(endOfYear(year), 'yyyy-MM-dd');

  return useQuery({
    queryKey: ['returned_loss_yearly', yearStart, yearEnd],
    queryFn: () => fetchReturnedLoss(yearStart, yearEnd),
  });
};
