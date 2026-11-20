import "../hub/hub.css";
import "./live.css";
import { LiveApp } from "./live-app";

export const metadata = {
  title: "Holocene · Live",
  description: "Apps in production: people can buy them and are using them. Sales, keys owed, release and storefront health"
};

export default function Page() {
  return <LiveApp />;
}
