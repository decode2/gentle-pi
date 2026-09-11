export const QUESTIONNAIRE_I18N_NAMESPACE = "gentle-pi.ask-user-question";

export type QuestionnaireLocalizer = (key: string, fallback: string) => string;

type Scope = (key: string, fallback: string) => unknown;
type Provider = { scope: (namespace: string) => Scope };
type Loader = { registerLocalesFromDir: (namespace: string, packageUrl: string, options?: { label?: string }) => unknown };

export interface QuestionnaireLocalizationBridgeOptions {
	readonly loadProvider?: () => Promise<unknown>;
	readonly loadLoader?: () => Promise<unknown>;
	readonly packageUrl?: string;
}

export async function createQuestionnaireLocalizer(
	options: QuestionnaireLocalizationBridgeOptions = {},
): Promise<QuestionnaireLocalizer> {
	const fallback: QuestionnaireLocalizer = (_key, value) => value;
	if (!options.loadProvider || !options.loadLoader || typeof options.packageUrl !== "string") return fallback;
	try {
		const [providerModule, loaderModule] = await Promise.all([options.loadProvider(), options.loadLoader()]);
		const provider = providerModule as Partial<Provider>;
		const loader = loaderModule as Partial<Loader>;
		if (typeof provider.scope !== "function" || typeof loader.registerLocalesFromDir !== "function") return fallback;
		await loader.registerLocalesFromDir(QUESTIONNAIRE_I18N_NAMESPACE, options.packageUrl);
		return (key, value) => {
			try {
				const scope = provider.scope!(QUESTIONNAIRE_I18N_NAMESPACE);
				if (typeof scope !== "function") return value;
				const translated = scope(key, value);
				return typeof translated === "string" && translated.trim().length > 0 && translated !== key ? translated : value;
			} catch {
				return value;
			}
		};
	} catch {
		return fallback;
	}
}
