import "../hub/hub.css";
import "./settings.css";
import { SettingsApp } from "./settings-app";

export const metadata = {
  title: "Holocene · Settings",
  description: "Holocene settings: agent avatars, mirrored to each agent's Telegram bot and the Agent Pad"
};

export default function Page() {
  return <SettingsApp />;
}
