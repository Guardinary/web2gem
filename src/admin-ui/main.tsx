import { render } from "preact";
import { App } from "./app";
import { initializeLanguage } from "./i18n";
import "./styles.css";
import { initializeTheme } from "./theme";

const root = document.getElementById("app");
if (root) {
	initializeLanguage();
	initializeTheme();
	render(<App />, root);
}
