export function deferred() {
	let settle;
	let fail;
	let settled = false;
	const promise = new Promise((resolve, reject) => {
		settle = resolve;
		fail = reject;
	});
	return {
		promise,
		get settled() {
			return settled;
		},
		resolve(value) {
			if (settled) return;
			settled = true;
			settle(value);
		},
		reject(error) {
			if (settled) return;
			settled = true;
			fail(error);
		},
	};
}
