import "../hub/hub.css";
import "./genesis.css";
import { GenesisApp } from "./genesis-app";

export const metadata = {
  title: "Holocene · Genesis",
  description: "Every Genesis event as a card: approvals waiting on a client, alerts from client assistants, and the full timeline"
};

export default function Page() {
  return <GenesisApp />;
}
