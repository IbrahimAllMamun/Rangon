import { LogoLoaderScreen } from "@/components/brand/logo-loader-screen";

/** Shown while any admin page streams in, inside the shell. */
export default function AdminLoading() {
  return <LogoLoaderScreen label="Loading" size={80} />;
}
