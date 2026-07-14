import { render } from "preact";
import { App } from "./app";
import { initializeLanguage } from "./i18n";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/components.css";
import "./styles/overlays.css";
import "./styles/responsive.css";
import { initializeTheme } from "./theme";

const root = document.getElementById("app");
if (root) {
	initializeLanguage();
	initializeTheme();
	render(<App />, root);
}
