import { tr } from "./i18n";

export type AdminLocalErrorDetails =
	| {
			key: "Cookie value required" | "Cookie value only";
			params: { name: string };
	  }
	| {
			key: "Batch row credentials required";
			params?: undefined;
	  };

export class AdminLocalError extends Error {
	constructor(readonly details: AdminLocalErrorDetails) {
		super(details.key);
		this.name = "AdminLocalError";
	}
}

export function adminLocalErrorMessage(error: AdminLocalError): string {
	const details = error.details;
	if (
		details.key === "Cookie value required" ||
		details.key === "Cookie value only"
	)
		return tr(details.key, details.params);
	return tr("Batch row credentials required");
}
