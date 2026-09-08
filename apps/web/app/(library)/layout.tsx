import type { ReactNode } from "react";
import { getItems, getStats } from "@/lib/queries";
import { ITEMS_PAGE_SIZE } from "@/lib/items-config";
import { toClientItem } from "@/lib/item-dto";
import { getAppSettings } from "@/lib/settings";
import HomeClient from "../home-client";

export const dynamic = "force-dynamic";

export default async function LibraryLayout({
	children,
}: {
	children: ReactNode;
}) {
	const settings = await getAppSettings();
	const [stats, items] = await Promise.all([
		getStats(),
		getItems(ITEMS_PAGE_SIZE, 0, false, settings.sort),
	]);

	return (
		<>
			<HomeClient
				initialStats={stats}
				initialHasMore={
					items.length === ITEMS_PAGE_SIZE && stats.items > items.length
				}
				initialImportPrefs={settings.import}
				initialView={settings.view}
				initialSort={settings.sort}
				initialItems={items.map(toClientItem)}
			/>
			{children}
		</>
	);
}
