import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { startOfYear, endOfYear, format, eachMonthOfInterval, differenceInDays } from 'date-fns';
import { id as idLocale } from 'date-fns/locale';
import { calculateTieredCommission, CommissionTier } from './useCommissionTiers';


export type ContractStatusFilter = 'all' | 'lancar' | 'kurang_lancar' | 'macet' | 'completed';

export interface MonthlyBreakdown {
  month: string;
  monthLabel: string;
  total_modal: number;
  total_omset: number;
  profit: number;
  commission: number;
  collected: number;
  operational: number;
  contracts_count: number;
}

export interface AgentYearlyPerformance {
  agent_id: string;
  agent_name: string;
  agent_code: string;
  commission_percentage: number;
  total_modal: number;
  total_omset: number;
  profit: number;
  total_commission: number;
  contracts_count: number;
}

export interface MonthlyContractDetail {
  agent_code: string;
  customer_name: string;
  product_type: string;
  modal: number;
  omset: number;
  commission: number;
  net_profit: number;
  start_date?: string;
  contract_ref?: string;
}

export interface MonthlyDetailData {
  monthKey: string;
  monthLabel: string;
  contracts: MonthlyContractDetail[];
  operational_expenses: { description: string; amount: number; category: string | null }[];
  total_operational: number;
  total_omset?: number;
}

export interface YearlyFinancialSummary {
  total_modal: number;
  total_omset: number;
  total_profit: number;
  total_commission: number;
  total_collected: number;
  total_to_collect: number;
  total_expenses: number;
  net_profit: number;
  net_profit_pct: number;
  contracts_count: number;
  completed_count: number;
  active_count: number;
  lancar_count: number;
  kurang_lancar_count: number;
  macet_count: number;
  profit_margin: number;
  collection_rate: number;
  monthly_breakdown: MonthlyBreakdown[];
  agents: AgentYearlyPerformance[];
  monthly_details: MonthlyDetailData[];
}

const calculateContractStatus = (contract: {
  status: string;
  current_installment_index: number;
  created_at: string;
}): 'completed' | 'lancar' | 'kurang_lancar' | 'macet' => {
  if (contract.status === 'completed') return 'completed';
  const daysSinceCreation = differenceInDays(new Date(), new Date(contract.created_at));
  const installmentsPaid = contract.current_installment_index;
  if (installmentsPaid === 0) {
    return daysSinceCreation > 7 ? 'macet' : daysSinceCreation > 3 ? 'kurang_lancar' : 'lancar';
  }
  const daysPerDue = daysSinceCreation / installmentsPaid;
  if (daysPerDue <= 1.2) return 'lancar';
  if (daysPerDue <= 2.0) return 'kurang_lancar';
  return 'macet';
};

/**
 * Ringkasan keuangan tahunan — CONTRACT BASIS (accrual).
 * Modal/Omset/Profit bulanan & tahunan dihitung dari NILAI PENUH kontrak,
 * dialokasikan ke bulan berdasarkan start_date kontrak.
 * Komisi: tier per total omset agen sepanjang tahun (full nilai kontrak).
 * total_collected & total_to_collect tetap dari realisasi (info pelengkap).
 */
export const useYearlyFinancialSummary = (year: Date = new Date(), statusFilter: ContractStatusFilter = 'all') => {
  const yearStart = format(startOfYear(year), 'yyyy-MM-dd');
  const yearEnd = format(endOfYear(year), 'yyyy-MM-dd');

  return useQuery({
    queryKey: ['yearly_financial_summary_contract', yearStart, yearEnd, statusFilter],
    queryFn: async (): Promise<YearlyFinancialSummary> => {
      const [
        { data: agents, error: agentsError },
        { data: contracts, error: contractsError },
        { data: payments, error: paymentsError },
        { data: expenses, error: expensesError },
        { data: unpaidCoupons, error: couponsError },
        { data: tiersData, error: tiersError },
      ] = await Promise.all([
        supabase.from('sales_agents').select('id, name, agent_code'),
        supabase.from('credit_contracts').select('id, contract_ref, omset, total_loan_amount, sales_agent_id, start_date, status, current_installment_index, tenor_days, created_at, product_type, customer_id, customers(name, phone)'),
        supabase.from('payment_logs').select('amount_paid, payment_date, contract_id').gte('payment_date', yearStart).lte('payment_date', yearEnd),
        supabase.from('operational_expenses').select('amount, expense_date, description, category').gte('expense_date', yearStart).lte('expense_date', yearEnd),
        supabase.from('installment_coupons').select('amount, due_date, contract_id').eq('status', 'unpaid').gte('due_date', yearStart).lte('due_date', yearEnd),
        supabase.from('commission_tiers').select('*').order('min_amount', { ascending: true }),
      ]);

      if (agentsError) throw agentsError;
      if (contractsError) throw contractsError;
      if (paymentsError) throw paymentsError;
      if (expensesError) throw expensesError;
      if (couponsError) throw couponsError;
      if (tiersError) throw tiersError;

      const tiers = (tiersData || []) as CommissionTier[];
      const selectedYear = year.getFullYear();

      // Lookups
      const agentLookup = new Map<string, { code: string; name: string }>();
      (agents || []).forEach((a: any) => agentLookup.set(a.id, { code: a.agent_code, name: a.name }));

      // Months scaffold
      const months = eachMonthOfInterval({ start: startOfYear(year), end: endOfYear(year) });
      const monthlyData: Map<string, MonthlyBreakdown> = new Map();
      const monthlyContractDetails: Map<string, Map<string, MonthlyContractDetail>> = new Map();
      const monthlyExpenseDetails: Map<string, { description: string; amount: number; category: string | null }[]> = new Map();
      const monthlyAgentOmset: Map<string, Map<string, number>> = new Map(); // monthKey -> agentId -> omset full

      months.forEach(monthDate => {
        const monthKey = format(monthDate, 'yyyy-MM');
        monthlyData.set(monthKey, {
          month: monthKey,
          monthLabel: format(monthDate, 'MMM yyyy', { locale: idLocale }),
          total_modal: 0, total_omset: 0, profit: 0, commission: 0,
          collected: 0, operational: 0, contracts_count: 0,
        });
        monthlyContractDetails.set(monthKey, new Map());
        monthlyExpenseDetails.set(monthKey, []);
        monthlyAgentOmset.set(monthKey, new Map());
      });

      // Totals (CONTRACT BASIS untuk modal/omset/profit, CASH untuk collected)
      let totalModal = 0;
      let totalOmset = 0;
      let totalCollected = 0;
      let totalExpenses = 0;

      const agentYearlyOmset = new Map<string, number>();
      const agentYearlyModal = new Map<string, number>();
      const agentYearlyContracts = new Map<string, Set<string>>();

      // Process kontrak: alokasikan FULL ke bulan start_date
      (contracts || []).forEach((contract: any) => {
        if (!contract.start_date) return;
        // Exclude kontrak yang di-return (macet permanen)
        if (contract.status === 'returned') return;
        const startDate = new Date(contract.start_date);
        if (startDate.getFullYear() !== selectedYear) return;

        const dynamicStatus = calculateContractStatus(contract);
        if (statusFilter !== 'all' && dynamicStatus !== statusFilter) return;

        const monthKey = format(startDate, 'yyyy-MM');
        const md = monthlyData.get(monthKey);
        if (!md) return;

        const omsetFull = Number(contract.total_loan_amount || 0);
        const modalFull = Number(contract.omset || 0);
        const profitFull = omsetFull - modalFull;

        totalModal += modalFull;
        totalOmset += omsetFull;

        md.total_modal += modalFull;
        md.total_omset += omsetFull;
        md.profit += profitFull;

        const agentId = contract.sales_agent_id;
        if (agentId) {
          const agentMonth = monthlyAgentOmset.get(monthKey)!;
          agentMonth.set(agentId, (agentMonth.get(agentId) || 0) + omsetFull);

          agentYearlyOmset.set(agentId, (agentYearlyOmset.get(agentId) || 0) + omsetFull);
          agentYearlyModal.set(agentId, (agentYearlyModal.get(agentId) || 0) + modalFull);
          const set = agentYearlyContracts.get(agentId) || new Set<string>();
          set.add(contract.id);
          agentYearlyContracts.set(agentId, set);
        }

        const detailMap = monthlyContractDetails.get(monthKey)!;
        const agentInfo = agentId ? agentLookup.get(agentId) : null;
        detailMap.set(contract.id, {
          agent_code: agentInfo?.code || '-',
          customer_name: contract.customers?.name || 'N/A',
          product_type: contract.product_type || '-',
          modal: modalFull,
          omset: omsetFull,
          commission: 0,
          net_profit: profitFull,
          start_date: contract.start_date,
          contract_ref: contract.contract_ref || (contract.id || '').toString(),
        });
      });

      // Process payments — hanya untuk total_collected per bulan & tahun (cash)
      (payments || []).forEach((p: any) => {
        const amt = Number(p.amount_paid || 0);
        totalCollected += amt;
        const monthKey = format(new Date(p.payment_date), 'yyyy-MM');
        const md = monthlyData.get(monthKey);
        if (md) md.collected += amt;
      });

      // Hitung komisi per bulan per agen berdasarkan omset (full kontrak) bulan tersebut
      let totalCommission = 0;
      const agentYearlyCommission = new Map<string, number>();
      const agentMonthlyCommission = new Map<string, Map<string, number>>();

      months.forEach((monthDate) => {
        const monthKey = format(monthDate, 'yyyy-MM');
        const agentMonth = monthlyAgentOmset.get(monthKey)!;
        agentMonth.forEach((omsetMonth, agentId) => {
          const commissionPct = omsetMonth > 0 ? calculateTieredCommission(omsetMonth, tiers) : 0;
          const commissionForMonth = (omsetMonth * commissionPct) / 100;
          if (!agentMonthlyCommission.has(agentId)) agentMonthlyCommission.set(agentId, new Map());
          agentMonthlyCommission.get(agentId)!.set(monthKey, commissionForMonth);
          agentYearlyCommission.set(agentId, (agentYearlyCommission.get(agentId) || 0) + commissionForMonth);
          totalCommission += commissionForMonth;
        });
      });

      // Alokasi komisi ke bulan & ke kontrak by share
      months.forEach((monthDate) => {
        const monthKey = format(monthDate, 'yyyy-MM');
        const md = monthlyData.get(monthKey)!;
        let monthCommission = 0;
        agentMonthlyCommission.forEach((monthMap) => {
          monthCommission += monthMap.get(monthKey) || 0;
        });
        md.commission = monthCommission;

        const detailMap = monthlyContractDetails.get(monthKey)!;
        if (md.total_omset > 0) {
          detailMap.forEach((d) => {
            const share = d.omset / md.total_omset;
            d.commission = monthCommission * share;
            d.net_profit = (d.omset - d.modal) - d.commission;
          });
        }
        md.contracts_count = detailMap.size;
      });

      // Process expenses by month
      (expenses || []).forEach((exp: any) => {
        const monthKey = format(new Date(exp.expense_date), 'yyyy-MM');
        const amount = Number(exp.amount || 0);
        totalExpenses += amount;
        const md = monthlyData.get(monthKey);
        if (md) md.operational += amount;
        const list = monthlyExpenseDetails.get(monthKey);
        if (list) list.push({ description: exp.description, amount, category: exp.category || null });
      });

      // Status counts
      let completedCount = 0, activeCount = 0, lancarCount = 0, kurangLancarCount = 0, macetCount = 0;
      let totalContractsCount = 0;

      (contracts || []).forEach((contract: any) => {
        const startYear = new Date(contract.start_date).getFullYear();
        if (startYear !== selectedYear) return;
        if (contract.status === 'returned') return;
        const dynamicStatus = calculateContractStatus(contract);
        if (statusFilter !== 'all' && dynamicStatus !== statusFilter) return;
        totalContractsCount++;
        switch (dynamicStatus) {
          case 'completed': completedCount++; break;
          case 'lancar': lancarCount++; activeCount++; break;
          case 'kurang_lancar': kurangLancarCount++; activeCount++; break;
          case 'macet': macetCount++; activeCount++; break;
        }
      });

      const totalProfit = totalOmset - totalModal;
      const totalToCollect = (unpaidCoupons || []).reduce((s: number, c: any) => s + Number(c.amount || 0), 0);
      const netProfit = totalProfit - totalCommission - totalExpenses;
      const netProfitPct = totalOmset > 0 ? (netProfit / totalOmset) * 100 : 0;
      const profitMargin = totalModal > 0 ? (totalProfit / totalModal) * 100 : 0;
      const expectedTotal = totalToCollect + totalCollected;
      const collectionRate = expectedTotal > 0 ? (totalCollected / expectedTotal) * 100 : 0;

      // Agent results
      const agentResults: AgentYearlyPerformance[] = (agents || []).map((agent: any) => {
        const total_omset = agentYearlyOmset.get(agent.id) || 0;
        const total_modal = agentYearlyModal.get(agent.id) || 0;
        const total_commission = agentYearlyCommission.get(agent.id) || 0;
        const commissionPct = total_omset > 0 ? calculateTieredCommission(total_omset, tiers) : 0;
        return {
          agent_id: agent.id,
          agent_name: agent.name,
          agent_code: agent.agent_code,
          commission_percentage: commissionPct,
          total_modal,
          total_omset,
          profit: total_omset - total_modal,
          total_commission,
          contracts_count: agentYearlyContracts.get(agent.id)?.size || 0,
        };
      }).filter(a => a.contracts_count > 0).sort((a, b) => b.total_omset - a.total_omset);

      // Monthly details
      const monthlyDetails: MonthlyDetailData[] = months.map(monthDate => {
        const monthKey = format(monthDate, 'yyyy-MM');
        const md = monthlyData.get(monthKey)!;
        const detailMap = monthlyContractDetails.get(monthKey)!;
        return {
          monthKey,
          monthLabel: md.monthLabel,
          contracts: Array.from(detailMap.values()),
          operational_expenses: monthlyExpenseDetails.get(monthKey) || [],
          total_operational: md.operational,
          total_omset: md.total_omset,
        };
      });

      return {
        total_modal: totalModal,
        total_omset: totalOmset,
        total_profit: totalProfit,
        total_commission: totalCommission,
        total_collected: totalCollected,
        total_to_collect: totalToCollect,
        total_expenses: totalExpenses,
        net_profit: netProfit,
        net_profit_pct: netProfitPct,
        contracts_count: totalContractsCount,
        completed_count: completedCount,
        active_count: activeCount,
        lancar_count: lancarCount,
        kurang_lancar_count: kurangLancarCount,
        macet_count: macetCount,
        profit_margin: profitMargin,
        collection_rate: collectionRate,
        monthly_breakdown: Array.from(monthlyData.values()),
        agents: agentResults,
        monthly_details: monthlyDetails,
      };
    },
  });
};
