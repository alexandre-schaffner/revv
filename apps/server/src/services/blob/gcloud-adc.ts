// Google Application Default Credentials: what `GcsBlobStore`'s SDK client
// authenticates with. The SDK discovers them on its own; this module answers
// the Settings UI's "are they there, and can we sign in" questions.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AdcStatus {
  available: boolean;
  source: "env" | "default" | null;
  gcloudFound: boolean;
  gcloudPath: string | null;
  adcPath: string;
}

export type AdcLoginStart = { started: true; pid: number } | { started: false; error: string };

function findGcloud(): string | null {
  const onPath = Bun.which("gcloud");
  if (onPath) return onPath;
  const candidates = [
    join(homedir(), "google-cloud-sdk", "bin", "gcloud"),
    "/opt/homebrew/bin/gcloud",
    "/usr/local/bin/gcloud",
    "/usr/bin/gcloud",
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/**
 * The credentials file alone isn't proof: `gcloud auth revoke` leaves it in
 * place, so ask gcloud for a token. Without gcloud, the file is all there is.
 */
async function isAdcValid(gcloudPath: string | null, adcExists: boolean): Promise<boolean> {
  if (!gcloudPath) return adcExists;
  try {
    const proc = Bun.spawn([gcloudPath, "auth", "application-default", "print-access-token"], {
      timeout: 5000,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export async function adcStatus(): Promise<AdcStatus> {
  const gcloudPath = findGcloud();
  // An explicit service-account key is trusted as configured: service-account
  // JSON keys don't work with `print-access-token`.
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (envPath && existsSync(envPath)) {
    return {
      available: true,
      source: "env",
      gcloudFound: gcloudPath !== null,
      gcloudPath,
      adcPath: envPath,
    };
  }
  const adcPath = join(homedir(), ".config", "gcloud", "application_default_credentials.json");
  const adcExists = existsSync(adcPath);
  return {
    available: adcExists && (await isAdcValid(gcloudPath, adcExists)),
    source: adcExists ? "default" : null,
    gcloudFound: gcloudPath !== null,
    gcloudPath,
    adcPath,
  };
}

/** Opens gcloud's browser sign-in, detached; the UI polls `adcStatus` for the result. */
export function startAdcLogin(): AdcLoginStart {
  const gcloudPath = findGcloud();
  if (!gcloudPath) {
    return { started: false, error: "gcloud CLI not found. Install the Google Cloud SDK first." };
  }
  const proc = Bun.spawn([gcloudPath, "auth", "application-default", "login"], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  proc.unref();
  return { started: true, pid: proc.pid };
}
