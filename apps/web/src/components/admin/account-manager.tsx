"use client";

import { ArrowRightLeft, Banknote, Landmark, Pencil, PencilLine, Plus, Smartphone, Wallet } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { AccountForm } from "@/components/admin/account-form";
import { MovementForm, TransferForm } from "@/components/admin/money-forms";
import { Badge, Button, Card, EmptyState } from "@/components/ui/primitives";
import type { Account, AccountKind } from "@/lib/api/types";
import { money } from "@/lib/format";

const KIND_ICON: Record<AccountKind, typeof Wallet> = {
  CASH: Banknote,
  BANK: Landmark,
  MFS: Smartphone,
  OTHER: Wallet,
};

type Panel = { kind: "none" } | { kind: "create" } | { kind: "edit"; account: Account } | { kind: "transfer" } | { kind: "movement" };

/**
 * The accounts table, with every write action this screen offers.
 *
 * One panel is open at a time. A finance screen where two half-filled forms
 * are visible at once is a screen where money gets posted to the wrong one.
 */
export function AccountManager({
  accounts,
  branchId,
  canManage,
  canTransfer,
  canAdjust,
}: {
  accounts: Account[];
  branchId: string;
  canManage: boolean;
  canTransfer: boolean;
  canAdjust: boolean;
}) {
  const [panel, setPanel] = useState<Panel>({ kind: "none" });
  const close = () => setPanel({ kind: "none" });

  const openAccounts = accounts.filter((account) => account.is_active);
  const canMoveMoney = canTransfer && openAccounts.length >= 2;

  return (
    <div className="space-y-6">
      {panel.kind === "create" && (
        <AccountForm branchId={branchId} onDone={close} onCancel={close} />
      )}
      {panel.kind === "edit" && (
        <AccountForm
          branchId={branchId}
          editing={panel.account}
          onDone={close}
          onCancel={close}
        />
      )}
      {panel.kind === "transfer" && (
        <TransferForm accounts={accounts} onDone={close} onCancel={close} />
      )}
      {panel.kind === "movement" && (
        <MovementForm accounts={accounts} onDone={close} onCancel={close} />
      )}

      {panel.kind === "none" && (
        <div className="flex flex-wrap gap-2">
          {canManage && (
            <Button onClick={() => setPanel({ kind: "create" })}>
              <Plus className="size-4" aria-hidden />
              Open account
            </Button>
          )}
          {canMoveMoney && (
            <Button variant="secondary" onClick={() => setPanel({ kind: "transfer" })}>
              <ArrowRightLeft className="size-4" aria-hidden />
              Transfer
            </Button>
          )}
          {canAdjust && openAccounts.length > 0 && (
            <Button variant="secondary" onClick={() => setPanel({ kind: "movement" })}>
              <PencilLine className="size-4" aria-hidden />
              Record entry
            </Button>
          )}
        </div>
      )}

      <Card className="overflow-hidden">
        {accounts.length === 0 ? (
          <EmptyState
            title="No accounts yet"
            description="Until an account exists, a sale records which method the customer paid by but not where the money went. Open the cash drawer first."
            action={
              canManage ? (
                <Button onClick={() => setPanel({ kind: "create" })}>
                  <Plus className="size-4" aria-hidden />
                  Open account
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-body-sm">
              <caption className="sr-only">Accounts and their balances</caption>
              <thead className="border-b border-border bg-neutral-50 text-left text-caption uppercase text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-medium">Account</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Kind</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Branch</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Balance</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                  <th scope="col" className="px-4 py-2.5">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {accounts.map((account) => {
                  const Icon = KIND_ICON[account.kind] ?? Wallet;
                  const negative = Number(account.balance) < 0;
                  return (
                    <tr key={account.id} className="hover:bg-neutral-50">
                      <td className="px-4 py-2.5">
                        <Link
                          href={`/admin/finance/${account.id}`}
                          className="font-medium text-brand-600 hover:underline"
                        >
                          {account.name}
                        </Link>
                        {(account.bank_name || account.account_number) && (
                          <span className="block text-caption text-muted">
                            {[account.bank_name, account.account_number]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="inline-flex items-center gap-1.5">
                          <Icon className="size-4 text-neutral-400" aria-hidden />
                          {account.kind_display}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-muted">{account.branch_code}</td>
                      <td
                        className={`tabular px-4 py-2.5 text-right font-medium ${
                          negative ? "text-[var(--error)]" : ""
                        }`}
                      >
                        {money(account.balance)}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="flex flex-wrap gap-1">
                          {account.is_active ? (
                            <Badge tone="success">Open</Badge>
                          ) : (
                            <Badge tone="neutral">Closed</Badge>
                          )}
                          {account.is_default && <Badge tone="info">Default</Badge>}
                          {account.allow_overdraft && <Badge tone="warning">Overdraft</Badge>}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {canManage && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setPanel({ kind: "edit", account })}
                          >
                            <Pencil className="size-4" aria-hidden />
                            <span className="sr-only sm:not-sr-only">Edit</span>
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
