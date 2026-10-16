import "../hub/hub.css";
import "./wax.css";
import { WaxApp } from "./wax-app";

export const metadata = {
  title: "Holocene · Wax",
  description: "The Wax enrichment system, read-only: passes, pipelines and drift from the safe discovery catalog"
};

export default function Page() {
  return <WaxApp />;
}
