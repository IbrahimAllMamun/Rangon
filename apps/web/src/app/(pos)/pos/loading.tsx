import { LogoLoaderScreen } from "@/components/brand/logo-loader-screen";

/** The register is opening. Full viewport — the POS has no surrounding chrome. */
export default function PosLoading() {
  return <LogoLoaderScreen label="Opening the register" variant="page" size={120} />;
}
