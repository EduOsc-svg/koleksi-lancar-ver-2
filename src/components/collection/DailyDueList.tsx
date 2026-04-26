import { useMemo, useState } from "react";
import { CalendarClock, CheckCircle2, AlertTriangle, Search, Wallet } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/ui/search-input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import { formatRupiah } from "@/lib/format";
import { useTodayDueCoupons, type CouponWithContract } from "@/hooks/useInstallmentCoupons";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { useLogActivity } from "@/hooks/useActivityLog";

/**
 * DailyDueList — Replaces the manual PaymentForm.
 *
 * Flow:
 *  1. Lists customers with installment coupons due TODAY (from installment_coupons table).
 *  2. Customers already paid for today are NOT shown (auto-removed).
 *  3. Each row has a "Bayar" action that opens a dialog form.
 *  4. In the dialog, the collector enters the number of "kupon kembali" (returned/unpaid).
 *     - Default = 0 → assume all of today's coupons are PAID.
 *     - Coupons NOT marked as kembali are recorded as PAID automatically.
 *     - Coupons marked as kembali stay UNPAID and show up in "Belum Bayar".
 *
 * The list refreshes automatically based on installment_coupons.due_date == today.
 */
export function DailyDueList() {
  const queryClient = useQueryClient();
  const logActivity = useLogActivity();
  const { data: dueCoupons, isLoading } = useTodayDueCoupons();
  const [searchQuery, setSearchQuery] = useState("");

  // Group coupons by contract (a single contract may have >1 coupon due same day in edge cases)
  const groupedByContract = useMemo(() => {
    const map = new Map<string, {
      contract_id: string;
      contract_ref: string;
      customer_name: string;
      collector_id: string | null;
      collector_name: string | null;
      daily_amount: number;
      coupons: CouponWithContract[];
    }>();
    for (const c of dueCoupons || []) {
      if (!c.credit_contracts) continue;
      const key = c.contract_id;
      const existing = map.get(key);
      if (existing) {
        existing.coupons.push(c);
      } else {
        map.set(key, {
          contract_id: c.contract_id,
          contract_ref: c.credit_contracts.contract_ref,
          customer_name: c.credit_contracts.customers?.name || "-",
          collector_id: c.credit_contracts.collector_id,
          collector_name: c.credit_contracts.collectors?.name || null,
          daily_amount: c.credit_contracts.daily_installment_amount,
          coupons: [c],
        });
      }
    }
    return Array.from(map.values());
  }, [dueCoupons]);

  const filteredRows = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return groupedByContract;
    return groupedByContract.filter(
      (r) =>
        r.customer_name.toLowerCase().includes(q) ||
        r.contract_ref.toLowerCase().includes(q),
    );
  }, [groupedByContract, searchQuery]);

  // Selected row for the dialog
  const [selected, setSelected] = useState<typeof groupedByContract[number] | null>(null);
  const [returnedCount, setReturnedCount] = useState<number>(0);
  const [submitting, setSubmitting] = useState(false);

  const openDialog = (row: typeof groupedByContract[number]) => {
    setSelected(row);
    setReturnedCount(0);
  };
  const closeDialog = () => {
    setSelected(null);
    setReturnedCount(0);
  };

  const handleSubmit = async () => {
    if (!selected) return;
    const total = selected.coupons.length;
    const returned = Math.max(0, Math.min(returnedCount, total));
    const paidCount = total - returned;

    // Sort coupons by installment_index ascending — pay the earliest ones first;
    // the LAST `returned` coupons stay unpaid.
    const sorted = [...selected.coupons].sort(
      (a, b) => a.installment_index - b.installment_index,
    );
    const toPay = sorted.slice(0, paidCount);

    setSubmitting(true);
    try {
      if (toPay.length > 0) {
        const today = new Date().toISOString().split("T")[0];
        // Insert payment_logs for each paid coupon
        const payments = toPay.map((c) => ({
          contract_id: selected.contract_id,
          payment_date: today,
          installment_index: c.installment_index,
          amount_paid: selected.daily_amount,
          collector_id: selected.collector_id,
          notes: `Pembayaran harian kupon ${c.installment_index}`,
        }));

        const { error: payErr } = await supabase.from("payment_logs").insert(payments);
        if (payErr) throw payErr;

        // Mark coupons as paid
        const paidIds = toPay.map((c) => c.id);
        const { error: couponErr } = await supabase
          .from("installment_coupons")
          .update({ status: "paid" })
          .in("id", paidIds);
        if (couponErr) throw couponErr;

        // Update contract.current_installment_index to highest paid index
        const maxIndex = Math.max(...toPay.map((c) => c.installment_index));
        const { error: cErr } = await supabase
          .from("credit_contracts")
          .update({ current_installment_index: maxIndex })
          .eq("id", selected.contract_id)
          .lt("current_installment_index", maxIndex);
        if (cErr) throw cErr;

        logActivity.mutate({
          action: "DAILY_COLLECTION",
          entity_type: "payment",
          entity_id: null,
          description:
            `Penagihan harian ${selected.contract_ref} (${selected.customer_name}): ` +
            `${paidCount} kupon LUNAS, ${returned} kupon KEMBALI`,
          contract_id: selected.contract_id,
        });
      } else {
        // All returned — log it but don't insert payments
        logActivity.mutate({
          action: "DAILY_COLLECTION",
          entity_type: "payment",
          entity_id: null,
          description:
            `Penagihan harian ${selected.contract_ref} (${selected.customer_name}): ` +
            `0 kupon LUNAS, ${returned} kupon KEMBALI`,
          contract_id: selected.contract_id,
        });
      }

      // Refresh queries
      queryClient.invalidateQueries({ queryKey: ["installment_coupons"] });
      queryClient.invalidateQueries({ queryKey: ["payment_logs"] });
      queryClient.invalidateQueries({ queryKey: ["credit_contracts"] });
      queryClient.invalidateQueries({ queryKey: ["outstanding_coupons"] });
      queryClient.invalidateQueries({ queryKey: ["collection_trend"] });
      queryClient.invalidateQueries({ queryKey: ["aggregated_payments"] });

      toast.success(
        `${selected.customer_name}: ${paidCount} lunas, ${returned} kembali`,
      );
      closeDialog();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Terjadi kesalahan";
      toast.error(`Gagal mencatat penagihan: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <CalendarClock className="h-5 w-5" />
            Daftar Penagihan Hari Ini
          </CardTitle>
          <CardDescription>
            Pelanggan dengan kupon jatuh tempo hari ini. Klik <strong>Bayar</strong> untuk
            mencatat hasil tagihan. Pelanggan yang sudah lunas otomatis hilang dari daftar.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <SearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Cari nama pelanggan atau kode kontrak..."
              className="max-w-md"
            />
            <Badge variant="secondary" className="text-sm">
              {filteredRows.length} pelanggan
            </Badge>
          </div>

          {isLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Memuat daftar...
            </div>
          ) : filteredRows.length === 0 ? (
            <Alert>
              <CheckCircle2 className="h-4 w-4" />
              <AlertDescription>
                {searchQuery
                  ? "Tidak ada pelanggan yang cocok dengan pencarian."
                  : "Semua pelanggan sudah lunas untuk hari ini. 🎉"}
              </AlertDescription>
            </Alert>
          ) : (
            <div className="rounded-md border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Kode Kontrak</TableHead>
                    <TableHead>Pelanggan</TableHead>
                    <TableHead>Kolektor</TableHead>
                    <TableHead className="text-center">Kupon Hari Ini</TableHead>
                    <TableHead className="text-right">Total Tagihan</TableHead>
                    <TableHead className="text-right">Aksi</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRows.map((row) => (
                    <TableRow key={row.contract_id}>
                      <TableCell className="font-mono text-sm">
                        {row.contract_ref}
                      </TableCell>
                      <TableCell className="font-medium">{row.customer_name}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {row.collector_name || "-"}
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant="outline">{row.coupons.length}</Badge>
                      </TableCell>
                      <TableCell className="text-right font-semibold">
                        {formatRupiah(row.daily_amount * row.coupons.length)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          onClick={() => openDialog(row)}
                          className="gap-1"
                        >
                          <Wallet className="h-3.5 w-3.5" />
                          Bayar
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Payment Dialog */}
      <Dialog open={!!selected} onOpenChange={(o) => !o && closeDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wallet className="h-5 w-5" />
              Catat Penagihan
            </DialogTitle>
            <DialogDescription>
              {selected?.customer_name} • {selected?.contract_ref}
            </DialogDescription>
          </DialogHeader>

          {selected && (
            <div className="space-y-4">
              <div className="rounded-lg border bg-muted/30 p-4 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Kupon hari ini:</span>
                  <span className="font-semibold">{selected.coupons.length} kupon</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Nominal per kupon:</span>
                  <span className="font-semibold">{formatRupiah(selected.daily_amount)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total tagihan:</span>
                  <span className="font-bold text-primary">
                    {formatRupiah(selected.daily_amount * selected.coupons.length)}
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="returned-count" className="text-sm font-medium">
                  Jumlah Kupon Kembali (Belum Terbayar)
                </Label>
                <Input
                  id="returned-count"
                  type="number"
                  min={0}
                  max={selected.coupons.length}
                  value={returnedCount}
                  onChange={(e) =>
                    setReturnedCount(
                      Math.max(
                        0,
                        Math.min(
                          selected.coupons.length,
                          parseInt(e.target.value) || 0,
                        ),
                      ),
                    )
                  }
                  className="text-center font-semibold text-lg"
                />
                <p className="text-xs text-muted-foreground">
                  Default <strong>0</strong> = semua kupon dianggap LUNAS. Isi sesuai
                  jumlah kupon yang dikembalikan kolektor (tidak berhasil ditagih).
                </p>
              </div>

              <Alert
                className={
                  returnedCount > 0
                    ? "border-warning/40 bg-warning/5"
                    : "border-primary/40 bg-primary/5"
                }
              >
                {returnedCount > 0 ? (
                  <AlertTriangle className="h-4 w-4 text-warning" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 text-primary" />
                )}
                <AlertDescription className="ml-2 space-y-1">
                  <div className="flex justify-between">
                    <span>Lunas:</span>
                    <span className="font-semibold">
                      {selected.coupons.length - returnedCount} kupon (
                      {formatRupiah(
                        selected.daily_amount *
                          (selected.coupons.length - returnedCount),
                      )}
                      )
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Kembali (belum bayar):</span>
                    <span className="font-semibold">
                      {returnedCount} kupon (
                      {formatRupiah(selected.daily_amount * returnedCount)})
                    </span>
                  </div>
                </AlertDescription>
              </Alert>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={closeDialog} disabled={submitting}>
              Batal
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? "Menyimpan..." : "Catat Penagihan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
