import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";

type DialogSurfaceProps = {
	labelledBy: string;
	describedBy?: string;
	onClose: () => void;
	children: JSX.Element | JSX.Element[];
};

export function DialogSurface({
	labelledBy,
	describedBy,
	onClose,
	children,
}: DialogSurfaceProps): JSX.Element {
	const dialogRef = useRef<HTMLDivElement>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	useEffect(() => {
		const previous =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		const dialog = dialogRef.current;
		const focusable = dialog ? dialogFocusable(dialog) : [];
		const initial =
			dialog?.querySelector<HTMLElement>("[data-dialog-initial]") ||
			focusable[0];
		initial?.focus();
		const handleKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				event.preventDefault();
				onCloseRef.current();
				return;
			}
			if (event.key !== "Tab" || !dialog) return;
			const items = dialogFocusable(dialog);
			if (!items.length) return;
			const first = items[0];
			const last = items[items.length - 1];
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last?.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first?.focus();
			}
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("keydown", handleKeyDown);
			previous?.focus();
		};
	}, []);
	return (
		<div class="modal open" aria-hidden="false">
			<div
				ref={dialogRef}
				class="dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby={labelledBy}
				aria-describedby={describedBy}
			>
				{children}
			</div>
		</div>
	);
}

function dialogFocusable(dialog: HTMLElement): HTMLElement[] {
	return [
		...dialog.querySelectorAll<HTMLElement>(
			"button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex='-1'])",
		),
	].filter((item) => !item.hasAttribute("hidden"));
}
