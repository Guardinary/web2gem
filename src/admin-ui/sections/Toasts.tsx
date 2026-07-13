import type { JSX } from "preact";
import { Icon } from "../icons";
import { tr } from "../i18n";
import { toastItems } from "../state";

export function Toasts(): JSX.Element {
	return (
		<div class="toast" aria-live="polite" aria-atomic="true">
			{toastItems.value.map((item) => (
				<div
					key={item.id}
					role={item.kind === "error" ? "alert" : "status"}
					class={`toast-item${item.kind === "error" ? " error" : ""}`}
				>
					<span class="toast-icon" aria-hidden="true">
						<Icon name={item.kind === "error" ? "alert" : "check"} />
					</span>
					<span class="toast-copy">
						<strong>{tr(item.kind === "error" ? "Error" : "Success")}</strong>
						<span>{item.message}</span>
					</span>
				</div>
			))}
		</div>
	);
}
