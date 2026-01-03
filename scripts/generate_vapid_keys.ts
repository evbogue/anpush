import webpush from "npm:web-push@3.6.7";

export type VapidConfig = {
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
};

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await Deno.readTextFile(path);
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(path: string, value: unknown) {
  const raw = JSON.stringify(value, null, 2);
  await Deno.writeTextFile(path, raw);
}

export async function ensureVapidConfig(
  configPath: string,
  subject: string,
): Promise<VapidConfig> {
  const fallback: VapidConfig = {
    vapidPublicKey: "",
    vapidPrivateKey: "",
    vapidSubject: subject,
  };
  const config = await readJsonFile<VapidConfig>(configPath, fallback);

  if (!config.vapidPublicKey || !config.vapidPrivateKey) {
    const keys = webpush.generateVAPIDKeys();
    const nextConfig: VapidConfig = {
      vapidPublicKey: keys.publicKey,
      vapidPrivateKey: keys.privateKey,
      vapidSubject: config.vapidSubject || subject,
    };
    await writeJsonFile(configPath, nextConfig);
    return nextConfig;
  }

  if (!config.vapidSubject) {
    config.vapidSubject = subject;
    await writeJsonFile(configPath, config);
  }

  return config;
}

if (import.meta.main) {
  const subject = Deno.env.get("VAPID_SUBJECT") ?? "mailto:ops@wiredove.net";
  const configPath = Deno.env.get("VAPID_CONFIG_PATH") ?? "./config.json";
  await ensureVapidConfig(configPath, subject);
  console.log(`Wrote VAPID keys to ${configPath}`);
}
