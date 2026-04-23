import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Menghitung jumlah pelanggan UNIK (baru vs lama) per sales agent.
 *
 * Acuan grouping pelanggan:
 *   - Utama: no HP (dinormalisasi: hilangkan non-digit, prefix 62 → 0)
 *   - Fallback: nama pelanggan (lowercase, trim) jika HP kosong
 *
 * Definisi:
 *   - Lama = pelanggan yang punya ≥2 kontrak (lintas agen, total)
 *   - Baru = pelanggan yang hanya punya 1 kontrak
 */

const normalizePhone = (phone: string | null | undefined): string => {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('62')) return '0' + digits.slice(2);
  if (digits.startsWith('0')) return digits;
  return digits;
};

const normalizeName = (name: string | null | undefined): string => {
  if (!name) return '';
  return String(name).trim().toLowerCase().replace(/\s+/g, ' ');
};

export interface AgentCustomerCounts {
  baru: number;
  lama: number;
}

export const useAgentCustomerCounts = () => {
  return useQuery({
    queryKey: ['agent_customer_counts'],
    queryFn: async () => {
      const { data: contracts, error } = await supabase
        .from('credit_contracts')
        .select('sales_agent_id, customer_id, customers(name, phone)');
      if (error) throw error;

      // 1) Hitung jumlah kontrak global per "customer key"
      const contractCountByKey = new Map<string, number>();
      // 2) Map customer_id → key (agar konsisten saat dipakai per agen)
      const keyByCustomerId = new Map<string, string>();

      (contracts || []).forEach((row: any) => {
        const phoneKey = normalizePhone(row.customers?.phone);
        const nameKey = normalizeName(row.customers?.name);
        const key = phoneKey ? `p:${phoneKey}` : nameKey ? `n:${nameKey}` : null;
        if (!key) return;
        contractCountByKey.set(key, (contractCountByKey.get(key) || 0) + 1);
        if (row.customer_id) keyByCustomerId.set(row.customer_id, key);
      });

      // 3) Per agen: kumpulkan pelanggan UNIK (berdasarkan key), lalu klasifikasi
      const perAgent = new Map<string, { baru: Set<string>; lama: Set<string> }>();

      (contracts || []).forEach((row: any) => {
        const agentId = row.sales_agent_id;
        if (!agentId || !row.customer_id) return;
        const key = keyByCustomerId.get(row.customer_id);
        if (!key) return;

        const totalContracts = contractCountByKey.get(key) || 1;
        const bucket = perAgent.get(agentId) || { baru: new Set<string>(), lama: new Set<string>() };
        if (totalContracts >= 2) bucket.lama.add(key);
        else bucket.baru.add(key);
        perAgent.set(agentId, bucket);
      });

      const result = new Map<string, AgentCustomerCounts>();
      perAgent.forEach((v, k) => {
        result.set(k, { baru: v.baru.size, lama: v.lama.size });
      });
      return result;
    },
  });
};
