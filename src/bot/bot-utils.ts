import {Window} from 'prismarine-windows';
import {Item} from 'prismarine-item';
import logger from '../shared/logger';

export function clean(text: string) {
	return text?.replace(/§[0-9a-fk-or]/gi, '');
}
export function findItem(name: string, window?: Window | null, inventory?: boolean): Item | null {
	if (!window) return null;
	const slot = findItemSlot(name, window, inventory);
	return window.slots[slot];
}
export function findItemSlot(customName: string, window: Window, inventory?: boolean): number {
	if (!window) {
		logger.debug(`Tried to find '${customName}' in an undefined window`);
		return -1;
	}
	for (
		let i = inventory ? window.inventoryStart : 0;
		i < (inventory ? window.inventoryEnd : window.inventoryStart);
		++i
	) {
		const item = window.slots[i];
		if (item?.customName && customName === clean(item.customName)) {
			return i;
		}
	}
	return -1;
}
export function getCleanLore(item?: Item | null): string {
	if (!item?.customLore) return '';
	return typeof item.customLore === 'string' ? item.customLore : item.customLore.map((e) => clean(e))?.join('') ?? '';
}
export function getNbt(item: Item, ...args: string[]) {
	if (!item.nbt) return undefined;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let result: any = item.nbt.value;
	for (const tag of args) {
		if (result == null || typeof result !== 'object' || !(tag in result) || !('value' in result[tag])) break;
		result = result[tag].value;
	}
	return result;
}
