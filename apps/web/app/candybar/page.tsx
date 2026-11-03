import "../hub/hub.css";
import "./candybar.css";
import { CandybarApp } from "./candybar-app";

export const metadata = {
  title: "Holocene · Candybar",
  description: "Every recurring job on the host, active and inactive, with its next fire and last run"
};

export default function Page() {
  return <CandybarApp />;
}
