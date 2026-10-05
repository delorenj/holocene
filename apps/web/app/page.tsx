import "./hub/hub.css";
import { HubApp } from "./hub/hub-app";

export const metadata = {
  title: "Holocene · Hub",
  description: "Agents and the pjangler projects they are attached to"
};

export default function Page() {
  return <HubApp />;
}
