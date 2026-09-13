import { HookObservatory } from "./observatory";
import "./hooks.css";

export const metadata = { title: "Hooks · Holocene", description: "Native CLI hooks, normalized Bloodbank events, and execution receipts." };

export default function HooksPage() {
  return <HookObservatory />;
}
