/**
 * MAIN-world injector — runs at document_start before X fetches the first page.
 */
import { installCaptureHooksWithQueue } from "@repo/import/capture/hooks-install";

installCaptureHooksWithQueue();
