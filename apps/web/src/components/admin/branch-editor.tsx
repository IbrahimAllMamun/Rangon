"use client";

import { Check, Pencil, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  ErrorSummary,
  Field,
  Input,
  Select,
} from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import { humanise } from "@/lib/format";

export interface Branch {
  id: string;
  name: string;
  code: string;
  address: string;
  phone: string;
  email: string;
  is_default: boolean;
  fulfils_online_orders: boolean;
  register_count: number;
  status: string;
}

const BLANK: Omit<Branch, "id"> = {
  name: "",
  code: "",
  address: "",
  phone: "",
  email: "",
  is_default: false,
  fulfils_online_orders: true,
  register_count: 1,
  status: "ACTIVE",
};

/**
 * Branch list with inline editing.
 *
 * A branch is not cosmetic — its code prints on receipts, its register count
 * drives the POS selector, and `fulfils_online_orders` decides where web stock
 * is reserved from. So this edits, it does not delete: branches are referenced
 * by orders and inventory (PROTECT), and are retired by setting status instead.
 */
export function BranchEditor({
  branches,
  canManage,
}: {
  branches: Branch[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Omit<Branch, "id">>(BLANK);
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [saving, setSaving] = useState(false);

  function startEdit(branch: Branch) {
    const { id: _id, ...rest } = branch;
    setDraft(rest);
    setEditing(branch.id);
    setCreating(false);
    setErrors([]);
  }

  function startCreate() {
    setDraft(BLANK);
    setCreating(true);
    setEditing(null);
    setErrors([]);
  }

  function cancel() {
    setEditing(null);
    setCreating(false);
    setErrors([]);
  }

  async function save() {
    const found: { field: string; message: string }[] = [];
    if (!draft.name.trim()) found.push({ field: "name", message: "Branch name is required." });
    if (!draft.code.trim()) found.push({ field: "code", message: "Branch code is required." });
    if (found.length) {
      setErrors(found);
      return;
    }

    setSaving(true);
    setErrors([]);
    try {
      if (creating) {
        await apiClient("/branches/", { method: "POST", body: draft });
      } else {
        await apiClient(`/branches/${editing}/`, { method: "PATCH", body: draft });
      }
      cancel();
      router.refresh();
    } catch (caught) {
      if (caught instanceof ApiError) {
        const fieldErrors = caught.fieldErrors();
        setErrors(fieldErrors.length ? fieldErrors : [{ field: "name", message: caught.message }]);
      } else {
        setErrors([{ field: "name", message: "Could not save the branch." }]);
      }
    } finally {
      setSaving(false);
    }
  }

  const errorFor = (field: string) => errors.find((error) => error.field === field)?.message;

  const form = (
    <div className="space-y-4 rounded-md border-2 border-brand-500 bg-brand-50 p-4">
      <ErrorSummary errors={errors} title="Could not save the branch" />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Branch name" htmlFor="br-name" required error={errorFor("name")}>
          <Input
            id="br-name"
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            invalid={Boolean(errorFor("name"))}
          />
        </Field>

        <Field
          label="Code"
          htmlFor="br-code"
          required
          hint="Short code printed on receipts, e.g. DHK1."
          error={errorFor("code")}
        >
          <Input
            id="br-code"
            value={draft.code}
            onChange={(event) => setDraft({ ...draft, code: event.target.value.toUpperCase() })}
            maxLength={16}
            invalid={Boolean(errorFor("code"))}
          />
        </Field>

        <Field label="Phone" htmlFor="br-phone" error={errorFor("phone")}>
          <Input
            id="br-phone"
            type="tel"
            value={draft.phone}
            onChange={(event) => setDraft({ ...draft, phone: event.target.value })}
          />
        </Field>

        <Field label="Email" htmlFor="br-email" error={errorFor("email")}>
          <Input
            id="br-email"
            type="email"
            value={draft.email}
            onChange={(event) => setDraft({ ...draft, email: event.target.value })}
          />
        </Field>

        <Field
          label="Registers"
          htmlFor="br-registers"
          hint="How many tills the POS offers."
          error={errorFor("register_count")}
        >
          <Input
            id="br-registers"
            type="number"
            min={1}
            max={20}
            value={draft.register_count}
            onChange={(event) =>
              setDraft({ ...draft, register_count: Math.max(1, Number(event.target.value) || 1) })
            }
          />
        </Field>

        <Field label="Status" htmlFor="br-status" error={errorFor("status")}>
          <Select
            id="br-status"
            value={draft.status}
            onChange={(event) => setDraft({ ...draft, status: event.target.value })}
          >
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
            <option value="SUSPENDED">Suspended</option>
          </Select>
        </Field>
      </div>

      <Field label="Address" htmlFor="br-address" error={errorFor("address")}>
        <Input
          id="br-address"
          value={draft.address}
          onChange={(event) => setDraft({ ...draft, address: event.target.value })}
        />
      </Field>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-body-sm">
          <Checkbox
            checked={draft.is_default}
            onChange={(event) => setDraft({ ...draft, is_default: event.target.checked })}
          />
          Default branch — used when no branch is specified
        </label>
        <label className="flex items-center gap-2 text-body-sm">
          <Checkbox
            checked={draft.fulfils_online_orders}
            onChange={(event) =>
              setDraft({ ...draft, fulfils_online_orders: event.target.checked })
            }
          />
          Fulfils online orders — web stock is reserved from here
        </label>
      </div>

      <div className="flex gap-2">
        <Button onClick={save} loading={saving}>
          <Check aria-hidden /> {creating ? "Create branch" : "Save branch"}
        </Button>
        <Button variant="secondary" onClick={cancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Branches</CardTitle>
        {canManage && !creating && !editing && (
          <Button size="sm" variant="secondary" onClick={startCreate}>
            <Plus aria-hidden /> Add branch
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {creating && form}

        {branches.length === 0 && !creating && (
          <p className="text-body-sm text-muted">No branches visible.</p>
        )}

        {branches.map((branch) =>
          editing === branch.id ? (
            <div key={branch.id}>{form}</div>
          ) : (
            <div key={branch.id} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-body-sm font-medium">
                    {branch.name} <span className="text-muted">({branch.code})</span>
                  </p>
                  <p className="mt-0.5 text-caption text-muted">
                    {branch.address || "No address set"}
                  </p>
                  <p className="text-caption text-muted">
                    {branch.phone || "No phone"} ·{" "}
                    {branch.register_count} register{branch.register_count === 1 ? "" : "s"}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <div className="flex flex-wrap justify-end gap-1">
                    {branch.is_default && <Badge tone="brand">Default</Badge>}
                    {branch.fulfils_online_orders && <Badge tone="info">Online orders</Badge>}
                    <Badge tone={branch.status === "ACTIVE" ? "success" : "neutral"}>
                      {humanise(branch.status)}
                    </Badge>
                  </div>
                  {canManage && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => startEdit(branch)}
                      aria-label={`Edit ${branch.name}`}
                    >
                      <Pencil aria-hidden />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ),
        )}

        {canManage && (
          <p className="text-caption text-muted">
            Branches are never deleted — orders and stock reference them. Retire one by setting its
            status to Inactive.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
