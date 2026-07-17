import type { JSX } from "preact";
import { useEffect } from "preact/hooks";
import { loadAccounts } from "./actions";
import { restoreAdminKey } from "./session";
import { ConfirmationModal, EditModal } from "./components";
import { AuthPanel } from "./sections/AuthPanel";
import { ImportPanel } from "./sections/ImportPanel";
import { OverviewSection } from "./sections/OverviewSection";
import { ModelRoutingSection } from "./sections/ModelRoutingSection";
import { Toasts } from "./sections/Toasts";
import { Topbar } from "./sections/Topbar";
import { Workspace } from "./sections/Workspace";
import { tr } from "./i18n";
import { adminKey, connectionVerified } from "./state";

export function App(): JSX.Element {
	useEffect(() => {
		restoreAdminKey();
		if (adminKey.value) void loadAccounts("reset", true);
	}, []);
	const connected = connectionVerified.value;

	return (
		<>
			{connected ? (
				<a class="skip-link" href="#accounts-workspace">
					{tr("Skip to accounts")}
				</a>
			) : null}
			<Topbar />
			<main class="shell">
				<AuthPanel />
				{connected ? (
					<>
						<OverviewSection />
						<ModelRoutingSection />
						<ImportPanel />
						<Workspace />
					</>
				) : null}
			</main>
			<EditModal />
			<ConfirmationModal />
			<Toasts />
		</>
	);
}
