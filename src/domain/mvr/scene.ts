/**
 * Reading `GeneralSceneDescription.xml` into a flat, world-space list.
 *
 * MVR is a tree — layers, groups, trusses with fixtures hung in their child
 * lists — and every `<Matrix>` is relative to its parent. Stagewash wants a
 * flat list of fixtures and focus points in one frame, so this walks the tree
 * once, composing transforms on the way down, and remembers just enough of the
 * hierarchy (the hanging position, the enclosing truss or group, the layer) to
 * work out later which fixtures share a bar.
 *
 * Nothing here knows about photometry or stagewash's rig types; that is
 * `importRig.ts`.
 */

import { compose, IDENTITY, parseMatrix, type Transform } from './matrix';
import { child, childrenNamed, childText, parseXml, type XmlElement } from './xml';

/** The object kinds a `<ChildList>` may hold. */
const OBJECT_NODES = new Set([
  'SceneObject',
  'GroupObject',
  'FocusPoint',
  'Fixture',
  'Support',
  'Truss',
  'VideoScreen',
  'Projector',
]);

export interface MvrContainer {
  kind: 'Layer' | 'Truss' | 'GroupObject' | 'Fixture' | 'SceneObject' | 'Support' | 'VideoScreen' | 'Projector';
  uuid: string;
  name: string;
}

export interface MvrFixture {
  uuid: string;
  name: string;
  /** `FixtureID` exactly as written — a string in MVR, and often empty. */
  fixtureId: string;
  fixtureIdNumeric?: number;
  unitNumber?: number;
  gdtfSpec: string;
  gdtfMode: string;
  /** World transform, millimetres. */
  transform: Transform;
  /** Normalised UUID of the `<FocusPoint>` this fixture aims at, if any. */
  focus?: string;
  /** Normalised UUID of the hanging position (`AUXData/Position`), if any. */
  position?: string;
  layer: { uuid: string; name: string };
  /** Nearest enclosing object other than the layer, if any. */
  parent?: MvrContainer;
  /** Set on a cell of a multipatch fixture; such cells are not lights on their own. */
  multipatch?: string;
  customCommands: string[];
}

export interface MvrFocusPoint {
  uuid: string;
  name: string;
  transform: Transform;
}

export interface MvrTruss {
  uuid: string;
  name: string;
  transform: Transform;
  position?: string;
}

export interface MvrUserData {
  provider: string;
  ver: string;
  /** Character data of the `<Data>` node (CDATA included). */
  text: string;
}

export interface MvrScene {
  verMajor: number;
  verMinor: number;
  provider: string;
  providerVersion: string;
  fixtures: MvrFixture[];
  focusPoints: Map<string, MvrFocusPoint>;
  /** Hanging positions, UUID → name. */
  positions: Map<string, string>;
  trusses: MvrTruss[];
  userData: MvrUserData[];
}

export class MvrParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MvrParseError';
  }
}

/**
 * Canonical form of a UUID for use as a key: lower case, dashed.
 *
 * Vectorworks writes upper case, Capture lower case, and the spec's own
 * example writes `4A B1 94 62 …` as space-separated bytes. All three have to
 * meet in the same lookup table or a fixture loses its focus point.
 */
export function normaliseUuid(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const hex = raw.replace(/[\s{}-]/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return raw.trim().toLowerCase() || undefined;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const parseIntOrUndefined = (text: string): number | undefined => {
  if (!text.trim()) return undefined;
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) ? n : undefined;
};

export function parseScene(xml: string): MvrScene {
  const root = parseXml(xml);
  if (root.name !== 'GeneralSceneDescription') {
    throw new MvrParseError(
      `GeneralSceneDescription.xml has a <${root.name}> root, not <GeneralSceneDescription>.`,
    );
  }

  const scene: MvrScene = {
    verMajor: Number.parseInt(root.attrs.verMajor ?? '', 10) || 0,
    verMinor: Number.parseInt(root.attrs.verMinor ?? '', 10) || 0,
    provider: root.attrs.provider ?? '',
    providerVersion: root.attrs.providerVersion ?? '',
    fixtures: [],
    focusPoints: new Map(),
    positions: new Map(),
    trusses: [],
    userData: [],
  };

  const userData = child(root, 'UserData');
  if (userData) {
    for (const data of childrenNamed(userData, 'Data')) {
      scene.userData.push({
        provider: data.attrs.provider ?? '',
        ver: data.attrs.ver ?? '1',
        text: data.text,
      });
    }
  }

  const sceneNode = child(root, 'Scene');
  if (!sceneNode) throw new MvrParseError('The scene description has no <Scene>.');

  const aux = child(sceneNode, 'AUXData');
  if (aux) {
    for (const p of childrenNamed(aux, 'Position')) {
      const uuid = normaliseUuid(p.attrs.uuid);
      if (uuid) scene.positions.set(uuid, p.attrs.name ?? '');
    }
  }

  const layers = child(sceneNode, 'Layers');
  for (const layer of layers ? childrenNamed(layers, 'Layer') : []) {
    const layerInfo = {
      uuid: normaliseUuid(layer.attrs.uuid) ?? '',
      name: layer.attrs.name ?? '',
    };
    const layerTransform = compose(IDENTITY, parseMatrix(childText(layer, 'Matrix')));
    walkChildList(child(layer, 'ChildList'), layerTransform, layerInfo, undefined, scene);
  }

  return scene;
}

function walkChildList(
  list: XmlElement | undefined,
  parentTransform: Transform,
  layer: { uuid: string; name: string },
  parent: MvrContainer | undefined,
  scene: MvrScene,
): void {
  if (!list) return;
  for (const node of list.children) {
    if (!OBJECT_NODES.has(node.name)) continue;
    const transform = compose(parentTransform, parseMatrix(childText(node, 'Matrix')));
    const uuid = normaliseUuid(node.attrs.uuid) ?? '';
    const name = node.attrs.name ?? '';

    switch (node.name) {
      case 'Fixture': {
        const multipatch = normaliseUuid(node.attrs.multipatch);
        const commands = child(node, 'CustomCommands');
        scene.fixtures.push({
          uuid,
          name,
          fixtureId: childText(node, 'FixtureID'),
          ...optional('fixtureIdNumeric', parseIntOrUndefined(childText(node, 'FixtureIDNumeric'))),
          ...optional('unitNumber', parseIntOrUndefined(childText(node, 'UnitNumber'))),
          gdtfSpec: childText(node, 'GDTFSpec'),
          gdtfMode: childText(node, 'GDTFMode'),
          transform,
          ...optional('focus', normaliseUuid(childText(node, 'Focus'))),
          ...optional('position', normaliseUuid(childText(node, 'Position'))),
          layer,
          ...optional('parent', parent),
          ...optional('multipatch', multipatch),
          customCommands: commands
            ? childrenNamed(commands, 'CustomCommand').map((c) => c.text)
            : [],
        });
        break;
      }
      case 'FocusPoint':
        scene.focusPoints.set(uuid, { uuid, name, transform });
        break;
      case 'Truss':
        scene.trusses.push({
          uuid,
          name,
          transform,
          ...optional('position', normaliseUuid(childText(node, 'Position'))),
        });
        break;
      default:
        break;
    }

    const kind = node.name === 'FocusPoint' ? undefined : (node.name as MvrContainer['kind']);
    if (kind) {
      walkChildList(child(node, 'ChildList'), transform, layer, { kind, uuid, name }, scene);
    }
  }
}

/** Spread-friendly optional property, so absent values stay absent under exactOptionalPropertyTypes. */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}
