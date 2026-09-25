/**
 * The staff form's own logic around personal details.
 *
 * The API owns the rules (who may read a profile, what a valid date is) and is
 * tested for them in `tests/api/test_staff_profiles.py`. These cover what only
 * the browser decides: what it sends, what it must never send, and where a
 * server error about a nested field is shown.
 *
 * Plain matchers only: this project registers no jest-dom setup file.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StaffForm, type StaffProfile, type StaffRow } from "./staff-manager";
import { ApiError } from "@/lib/api/client";

const apiClient = vi.fn();

vi.mock("@/lib/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/client")>("@/lib/api/client");
  return { ...actual, apiClient: (...args: unknown[]) => apiClient(...args) };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

const ROLES = [{ id: "r1", code: "CASHIER", name: "Cashier", is_staff_role: true }];
const BRANCHES = [{ id: "b1", name: "Main", code: "DHK1" }];

const PROFILE: StaffProfile = {
  designation: "Cashier",
  joined_on: "2026-09-01",
  date_of_birth: null,
  national_id: "",
  blood_group: "",
  present_address: "House 12, Dhanmondi",
  permanent_address: "Village Char Bhadrasan, Faridpur",
  emergency_contact_name: "",
  emergency_contact_relation: "",
  emergency_contact_phone: "",
  notes: "",
};

function row(profile?: StaffProfile): StaffRow {
  return {
    id: "u1",
    email: "cashier@rangon.test",
    first_name: "Rina",
    last_name: "Akter",
    full_name: "Rina Akter",
    phone: "",
    role: "r1",
    role_code: "CASHIER",
    role_name: "Cashier",
    branch: "b1",
    branch_name: "Main",
    status: "ACTIVE",
    date_joined: "2026-09-01T04:00:00Z",
    last_login: null,
    profile,
  };
}

function renderForm(editing?: StaffRow) {
  return render(
    <StaffForm
      editing={editing}
      roles={ROLES}
      branches={BRANCHES}
      isSelf={false}
      isLastOwner={false}
      onDone={() => {}}
      onCancel={() => {}}
    />,
  );
}

function sentBody(): Record<string, unknown> {
  expect(apiClient).toHaveBeenCalledTimes(1);
  return apiClient.mock.calls[0][1].body;
}

beforeEach(() => {
  apiClient.mockReset();
  apiClient.mockResolvedValue({});
});

describe("StaffForm personal details", () => {
  it("sends the profile with the account, and an empty date as null", async () => {
    renderForm(row(PROFILE));

    fireEvent.change(screen.getByLabelText("Designation"), { target: { value: "Senior cashier" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(apiClient).toHaveBeenCalled());
    const profile = sentBody().profile as StaffProfile;
    expect(profile.designation).toBe("Senior cashier");
    expect(profile.present_address).toBe("House 12, Dhanmondi");
    // The API reads "" as an unreadable date; nothing entered means null.
    expect(profile.date_of_birth).toBeNull();
  });

  it("copies the present address when the two are marked the same", async () => {
    renderForm(row(PROFILE));

    fireEvent.click(screen.getByLabelText("Permanent address is the same as present"));
    expect((screen.getByLabelText("Permanent address") as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(apiClient).toHaveBeenCalled());
    expect((sentBody().profile as StaffProfile).permanent_address).toBe("House 12, Dhanmondi");
  });

  it("sends no profile for a row that came without one, so nothing unseen is erased", async () => {
    // A row without `profile` is what the API returns to someone who may not
    // read it. Sending the form's blanks would wipe what they cannot see.
    renderForm(row(undefined));

    expect(screen.queryByLabelText("Present address")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(apiClient).toHaveBeenCalled());
    expect(sentBody()).not.toHaveProperty("profile");
  });

  it("shows a nested server error under the field it is about", async () => {
    apiClient.mockRejectedValue(
      new ApiError(400, "VALIDATION_ERROR", "Invalid input.", {
        profile: { national_id: ["Another member of staff already has this ID number."] },
      }),
    );
    renderForm(row(PROFILE));

    fireEvent.change(screen.getByLabelText("National ID"), { target: { value: "1234567890" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const input = await screen.findByLabelText("National ID");
    await waitFor(() =>
      expect(document.getElementById(`${input.id}-error`)?.textContent).toBe(
        "Another member of staff already has this ID number.",
      ),
    );
    // And the summary at the top links to that same input.
    expect(
      screen
        .getByRole("link", { name: "Another member of staff already has this ID number." })
        .getAttribute("href"),
    ).toBe(`#${input.id}`);
  });

  it("offers the personal sections when creating an account", () => {
    renderForm(undefined);

    expect(screen.queryByLabelText("Present address")).not.toBeNull();
    expect(screen.queryByLabelText("National ID")).not.toBeNull();
  });
});
