import {
  LABEL_SIZE,
  materialSize,
} from '../../../../../shared/generation/node-geometry';
import type { ShotWorkspace } from '../../../../../shared/generation/workspace';
import type { Asset } from '../../../../../shared/models';
import { matchesSearch, searchWords } from '../../../lib/search';

export const materialSearchKinds = {
  text: '文本',
  image: '图片',
  video: '视频',
  audio: '音频',
  label: '标签',
  group: '生成组',
  unavailable: '不可用素材',
} as const;
export type MaterialSearchKind = keyof typeof materialSearchKinds;
export type MaterialSearchFilter = 'all' | MaterialSearchKind;
export type MaterialSearchEntry = {
  id: string;
  kind: MaterialSearchKind;
  name: string;
  typeLabel: string;
  context: string;
  searchValues: string[];
  position: { x: number; y: number };
  width: number;
  height: number;
};

const excerpt = (text: string) =>
  text.replace(/\s+/g, ' ').trim().slice(0, 120);

/** Index in-memory editor values only; finding a card never reads its media. */
export function buildMaterialSearchEntries(
  shot: ShotWorkspace,
  assets: readonly Asset[],
): MaterialSearchEntry[] {
  const byAsset = new Map(assets.map((asset) => [asset.id, asset]));
  const byGroup = new Map(shot.groups.map((group) => [group.id, group]));
  const groupNames = new Map(
    shot.groups.map((group, index) => [
      group.id,
      `${group.kind === 'image' ? '图片' : '视频'}生成组 ${index + 1}`,
    ]),
  );
  const nodes: MaterialSearchEntry[] = shot.nodes.map((node) => {
    const asset = node.type === 'asset' ? byAsset.get(node.assetId) : undefined;
    const kind = node.type === 'text' ? 'text' : (asset?.kind ?? 'unavailable');
    const typeLabel = materialSearchKinds[kind];
    const name =
      node.name ?? asset?.name ?? (node.type === 'text' ? '文本' : '素材引用');
    const text = node.type === 'text' ? node.text : (node.textOverride ?? '');
    const group = node.groupId ? byGroup.get(node.groupId) : undefined;
    const groupName = group ? groupNames.get(group.id) : undefined;
    const context = [
      groupName ? `位于${groupName}` : '独立卡片',
      asset && node.name ? `原文件：${asset.name}` : '',
      excerpt(text),
      kind === 'unavailable' ? '素材正在保存或暂不可用' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return {
      id: node.id,
      kind,
      name,
      typeLabel,
      context,
      searchValues: [name, asset?.name ?? '', typeLabel, text, groupName ?? ''],
      position: {
        x: node.position.x + (group?.position.x ?? 0),
        y: node.position.y + (group?.position.y ?? 0),
      },
      ...materialSize(node),
    };
  });
  const byNode = new Map(nodes.map((node) => [node.id, node]));
  const groups: MaterialSearchEntry[] = shot.groups.map((group) => {
    const members = shot.nodes
      .filter((node) => node.groupId === group.id)
      .flatMap((node) => {
        const entry = byNode.get(node.id);
        return entry ? [entry] : [];
      });
    const typeLabel = group.kind === 'image' ? '图片生成组' : '视频生成组';
    const name = groupNames.get(group.id) ?? typeLabel;
    return {
      id: group.id,
      kind: 'group',
      name,
      typeLabel,
      context: `${members.length} 个素材 · ${members.map((member) => member.name).join('、')}`,
      searchValues: [
        name,
        typeLabel,
        ...members.flatMap((member) => member.searchValues),
      ],
      position: { ...group.position },
      width: group.width,
      height: group.height,
    };
  });
  const labels: MaterialSearchEntry[] = (shot.labels ?? []).map((label) => ({
    id: label.id,
    kind: 'label',
    name: label.name,
    typeLabel: '标签',
    context: label.pinned ? '已固定位置的标签' : '画布标签',
    searchValues: [label.name, '标签'],
    position: { ...label.position },
    ...LABEL_SIZE,
  }));
  return [...nodes, ...labels, ...groups];
}

export function filterMaterialSearchEntries(
  entries: readonly MaterialSearchEntry[],
  query: string,
  kind: MaterialSearchFilter = 'all',
): MaterialSearchEntry[] {
  const words = searchWords(query);
  return entries.filter(
    (entry) =>
      (kind === 'all' || kind === entry.kind) &&
      matchesSearch(entry.searchValues, words),
  );
}

export function materialSearchTarget(
  shot: ShotWorkspace,
  assets: readonly Asset[],
  id: string,
): MaterialSearchEntry | null {
  return (
    buildMaterialSearchEntries(shot, assets).find((entry) => entry.id === id) ??
    null
  );
}
