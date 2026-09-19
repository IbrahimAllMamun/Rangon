/**
 * The password form's own logic. The server owns the rules (current password,
 * the validators, "must be new", the rate limit) and its tests prove them —
 * tests/api/test_password_self_service.py. These cover what lives only here:
 * the typo guard, which never reaches the server, and putting each server
 * error beside the field it is about.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PasswordChangeForm } from "./password-change-form";

/** By id: "New password" is also the start of "New password again". */
const input = (id: string) => document.getElementById(id) as HTMLInputElement;

function fill(current: string, next: string, again = next) {
  fireEvent.change(input("current-password"), { target: { value: current } });
  fireEvent.change(input("new-password"), { target: { value: next } });
  fireEvent.change(input("confirm-password"), { target: { value: again } });
  fireEvent.click(screen.getByRole("button", { name: /change password/i }));
}

function answer(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PasswordChangeForm", () => {
  it("catches a mistyped confirmation without asking the server", () => {
    const fetchMock = answer(200, { ok: true });
    render(<PasswordChangeForm />);

    fill("old-password-1", "new-password-long-1", "new-password-long-2");

    expect(screen.getAllByText("The two new passwords do not match.").length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to the app's own route, never the proxy that would expose the tokens", async () => {
    const fetchMock = answer(200, { ok: true });
    render(<PasswordChangeForm />);

    fill("old-password-1", "new-password-long-1");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/auth/password");
    expect(JSON.parse(init.body)).toEqual({
      current_password: "old-password-1",
      new_password: "new-password-long-1",
    });
  });

  it("says what happened to the other sessions, and clears the fields", async () => {
    answer(200, { ok: true });
    render(<PasswordChangeForm />);

    fill("old-password-1", "new-password-long-1");

    // Plain matchers only: this project registers no jest-dom setup file.
    expect((await screen.findByRole("status")).textContent).toMatch(/signed out/i);
    expect(input("current-password").value).toBe("");
  });

  it("puts the server's refusal beside the field it is about", async () => {
    answer(400, {
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid input.",
        details: { new_password: ["This password is too common."] },
      },
    });
    render(<PasswordChangeForm />);

    fill("old-password-1", "password1234");

    await waitFor(() => expect(input("new-password").getAttribute("aria-invalid")).toBe("true"));
    expect(screen.getAllByText("This password is too common.").length).toBeGreaterThan(0);
  });

  it("explains a rate limit in words rather than a status code", async () => {
    answer(429, { error: { code: "THROTTLED", message: "Request was throttled.", details: {} } });
    render(<PasswordChangeForm />);

    fill("guess-1", "new-password-long-1");

    expect((await screen.findAllByText(/too many attempts/i)).length).toBeGreaterThan(0);
  });
});
