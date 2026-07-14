import type { JSX } from "preact";
import { useEffect } from "preact/hooks";
import { loadAccounts, restoreAdminKey } from "./actions";
import { ConfirmationModal, EditModal } from "./components";
import { AuthPanel } from "./sections/AuthPanel";
import { ImportPanel } from "./sections/ImportPanel";
import { OverviewSection } from "./sections/OverviewSection";
import { Toasts } from "./sections/Toasts";
import { Topbar } from "./sections/Topbar";
import { Workspace } from "./sections/Workspace";
import { tr } from "./i18n";
import { adminKey } from "./state";

export function App(): JSX.Element {
	useEffect(() => {
		restoreAdminKey();
		if (adminKey.value) void loadAccounts("reset", true);
	}, []);

	return (
		<>
			<a class="skip-link" href="#accounts-workspace">
				{tr("Skip to accounts")}
			</a>
			<Topbar />
			<main class="shell">
				<AuthPanel />
				<OverviewSection />
				<ImportPanel />
				<Workspace />
			</main>
			<EditModal />
			<ConfirmationModal />
			<Toasts />
		</>
	);
}
