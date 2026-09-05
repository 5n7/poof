export interface BrowserProcess {
	unref(): void;
}

export type BrowserSpawn = (
	command: string[],
	options: { env: Record<string, string | undefined>; stdin: "ignore"; stdout: "ignore"; stderr: "ignore" },
) => BrowserProcess;

const defaultSpawn: BrowserSpawn = (command, options) => Bun.spawn(command, options);

function browserCommand(platform: NodeJS.Platform, url: string): string[] {
	switch (platform) {
		case "darwin":
			return ["open", url];
		case "win32":
			return ["rundll32.exe", "url.dll,FileProtocolHandler", url];
		default:
			return ["xdg-open", url];
	}
}

export function openBrowser(
	url: string,
	spawn: BrowserSpawn = defaultSpawn,
	environment: NodeJS.ProcessEnv = process.env,
): boolean {
	const command = browserCommand(process.platform, url);
	const env = { ...environment };
	delete env.POOF_ACCESS_CLIENT_ID;
	delete env.POOF_ACCESS_CLIENT_SECRET;
	try {
		const child = spawn(command, { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		child.unref();
		return true;
	} catch {
		return false;
	}
}
