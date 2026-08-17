import { PosRegister } from "@/components/pos/register";
import { apiServer } from "@/lib/api/client";
import type { PosSession } from "@/lib/api/types";

export default async function PosPage() {
  let session: PosSession | null = null;
  let error: string | null = null;

  try {
    session = await apiServer<PosSession>("/pos/session/");
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not open the register.";
  }

  if (!session) {
    return (
      <div className="grid min-h-screen place-items-center p-6">
        <div role="alert" className="max-w-md rounded-lg border border-[var(--error)] bg-[var(--error-bg)] p-6 text-center">
          <h1 className="text-h3 text-[var(--error)]">Register unavailable</h1>
          <p className="mt-2 text-body-sm">{error}</p>
        </div>
      </div>
    );
  }

  return <PosRegister session={session} />;
}
