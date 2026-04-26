import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, Wallet, Coins, Receipt } from "lucide-react";
import { usePayments } from "@/hooks/usePayments";
import { useContracts } from "@/hooks/useContracts";
import { formatRupiah, formatDate } from "@/lib/format";

export function DailyProfitList() {
  const today = new Date().toISOString().split("T")[0];
  const [selectedDate, setSelectedDate] = useState(today);

  const { data: payments, isLoading: paymentsLoading } = usePayments(selectedDate, selectedDate);
  const { data: contracts, isLoading: contractsLoading } = useContracts();

  const isLoading = paymentsLoading || contractsLoading;

  // Build map: contract_id -> { profitPerCoupon, modalPerCoupon, omsetPerCoupon, contract_ref, customer_name }
  const contractMap = useMemo(() => {
    const map = new Map<string, {
      contract_ref: string;
      customer_name: string;
      tenor_days: number;
      total_loan_amount: number; // omset (yang ditagih ke pelanggan)
      modal_total: number;        // modal (field omset di DB = modal awal)
      profit_total: number;
      profit_per_coupon: number;
      modal_per_coupon: number;
      omset_per_coupon: number;
    }>();
    (contracts || []).forEach((c: any) => {
      const omsetTotal = Number(c.total_loan_amount || 0);
      const modalTotal = Number(c.omset || 0);
      const profitTotal = omsetTotal - modalTotal;
      const tenor = Number(c.tenor_days || 0) || 1;
      map.set(c.id, {
        contract_ref: c.contract_ref,
        customer_name: c.customers?.name || "-",
        tenor_days: tenor,
        total_loan_amount: omsetTotal,
        modal_total: modalTotal,
        profit_total: profitTotal,
        profit_per_coupon: profitTotal / tenor,
        modal_per_coupon: modalTotal / tenor,
        omset_per_coupon: omsetTotal / tenor,
      });
    });
    return map;
  }, [contracts]);

  // Aggregate per contract for selected date
  const rows = useMemo(() => {
    if (!payments) return [];
    const grouped = new Map<string, {
      contract_id: string;
      contract_ref: string;
      customer_name: string;
      coupons_paid: number;
      collected: number;       // total dibayar (cash basis)
      modal_portion: number;   // porsi modal
      profit_portion: number;  // porsi profit
    }>();

    payments.forEach((p: any) => {
      const info = contractMap.get(p.contract_id);
      if (!info) return;
      const existing = grouped.get(p.contract_id) || {
        contract_id: p.contract_id,
        contract_ref: info.contract_ref,
        customer_name: info.customer_name,
        coupons_paid: 0,
        collected: 0,
        modal_portion: 0,
        profit_portion: 0,
      };
      existing.coupons_paid += 1;
      existing.collected += Number(p.amount_paid || 0);
      existing.modal_portion += info.modal_per_coupon;
      existing.profit_portion += info.profit_per_coupon;
      grouped.set(p.contract_id, existing);
    });

    return Array.from(grouped.values()).sort((a, b) => b.profit_portion - a.profit_portion);
  }, [payments, contractMap]);

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, r) => {
        acc.coupons += r.coupons_paid;
        acc.collected += r.collected;
        acc.modal += r.modal_portion;
        acc.profit += r.profit_portion;
        return acc;
      },
      { coupons: 0, collected: 0, modal: 0, profit: 0 }
    );
  }, [rows]);

  const margin = totals.collected > 0 ? (totals.profit / totals.collected) * 100 : 0;

  return (
    <div className="space-y-4">
      {/* Filter */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">Keuntungan Harian</CardTitle>
          <CardDescription>
            Profit harian dihitung dari pembayaran kupon yang masuk pada tanggal terpilih.
            Profit per kupon = (Omset Kontrak − Modal Kontrak) / Tenor.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-w-xs">
            <Label htmlFor="profit-date">Tanggal</Label>
            <Input
              id="profit-date"
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
              <Receipt className="h-4 w-4" /> Kupon Tertagih
            </div>
            <div className="text-2xl font-bold">{totals.coupons}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
              <Wallet className="h-4 w-4" /> Total Tertagih
            </div>
            <div className="text-2xl font-bold">{formatRupiah(totals.collected)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
              <Coins className="h-4 w-4" /> Porsi Modal
            </div>
            <div className="text-2xl font-bold">{formatRupiah(totals.modal)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
              <TrendingUp className="h-4 w-4" /> Keuntungan
            </div>
            <div className="text-2xl font-bold text-primary">{formatRupiah(totals.profit)}</div>
            <div className="text-xs text-muted-foreground mt-1">Margin {margin.toFixed(1)}%</div>
          </CardContent>
        </Card>
      </div>

      {/* Detail table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Detail per Kontrak — {formatDate(selectedDate)}</CardTitle>
          <CardDescription>
            Rincian kupon yang dibayar pada tanggal terpilih beserta porsi modal & keuntungan per kontrak.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ScrollArea className="rounded-md border" style={{ maxHeight: "500px" }}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Kontrak</TableHead>
                  <TableHead>Pelanggan</TableHead>
                  <TableHead className="text-center">Kupon</TableHead>
                  <TableHead className="text-right">Tertagih</TableHead>
                  <TableHead className="text-right">Modal</TableHead>
                  <TableHead className="text-right">Keuntungan</TableHead>
                  <TableHead className="text-right">Margin</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-6 text-muted-foreground">
                      Memuat data...
                    </TableCell>
                  </TableRow>
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-6 text-muted-foreground">
                      Tidak ada pembayaran pada tanggal ini.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((r) => {
                    const m = r.collected > 0 ? (r.profit_portion / r.collected) * 100 : 0;
                    return (
                      <TableRow key={r.contract_id}>
                        <TableCell className="font-mono text-xs">{r.contract_ref}</TableCell>
                        <TableCell>{r.customer_name}</TableCell>
                        <TableCell className="text-center">
                          <Badge variant="secondary">{r.coupons_paid}</Badge>
                        </TableCell>
                        <TableCell className="text-right">{formatRupiah(r.collected)}</TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {formatRupiah(r.modal_portion)}
                        </TableCell>
                        <TableCell className="text-right font-semibold text-primary">
                          {formatRupiah(r.profit_portion)}
                        </TableCell>
                        <TableCell className="text-right text-xs">{m.toFixed(1)}%</TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
