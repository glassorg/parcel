// @flow strict-local

import type {
  BundleGroup,
  GraphVisitor,
  SourceLocation,
  Symbol,
  TraversalActions,
} from '@parcel/types';
import querystring from 'querystring';

import type {
  Asset,
  AssetNode,
  Bundle,
  BundleGraphNode,
  Dependency,
  DependencyNode,
} from './types';
import type AssetGraph from './AssetGraph';

import assert from 'assert';
import invariant from 'assert';
import crypto from 'crypto';
import nullthrows from 'nullthrows';
import {flatMap, objectSortedEntriesDeep, unique} from '@parcel/utils';

import {getBundleGroupId, getPublicId} from './utils';
import Graph, {ALL_EDGE_TYPES, mapVisitor, type GraphOpts} from './Graph';

type BundleGraphEdgeTypes =
  // A lack of an edge type indicates to follow the edge while traversing
  // the bundle's contents, e.g. `bundle.traverse()` during packaging.
  | null
  // Used for constant-time checks of presence of a dependency or asset in a bundle,
  // avoiding bundle traversal in cases like `isAssetInAncestors`
  | 'contains'
  // Connections between bundles and bundle groups, for quick traversal of the
  // bundle hierarchy.
  | 'bundle'
  // Indicates that the asset a dependency references is contained in another bundle.
  // Using this type prevents referenced assets from being traversed normally.
  | 'references'
  | 'internal_async';

type InternalSymbolResolution = {|
  asset: Asset,
  exportSymbol: string,
  symbol: ?Symbol | false,
  loc: ?SourceLocation,
|};

type InternalExportSymbolResolution = {|
  ...InternalSymbolResolution,
  +exportAs: Symbol | string,
|};

type SerializedBundleGraph = {|
  $$raw: true,
  graph: GraphOpts<BundleGraphNode, BundleGraphEdgeTypes>,
  bundleContentHashes: Map<string, string>,
  assetPublicIds: Set<string>,
  publicIdByAssetId: Map<string, string>,
|};

function makeReadOnlySet<T>(set: Set<T>): $ReadOnlySet<T> {
  return new Proxy(set, {
    get(target, property) {
      if (property === 'delete' || property === 'add' || property === 'clear') {
        return undefined;
      } else {
        // $FlowFixMe
        let value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      }
    },
  });
}

export default class BundleGraph {
  _assetPublicIds: Set<string>;
  _publicIdByAssetId: Map<string, string>;
  // TODO: These hashes are being invalidated in mutative methods, but this._graph is not a private
  // property so it is possible to reach in and mutate the graph without invalidating these hashes.
  // It needs to be exposed in BundlerRunner for now based on how applying runtimes works and the
  // BundlerRunner takes care of invalidating hashes when runtimes are applied, but this is not ideal.
  _bundleContentHashes: Map<string, string>;
  _graph: Graph<BundleGraphNode, BundleGraphEdgeTypes>;

  constructor({
    graph,
    publicIdByAssetId,
    assetPublicIds,
    bundleContentHashes,
  }: {|
    graph: Graph<BundleGraphNode, BundleGraphEdgeTypes>,
    publicIdByAssetId: Map<string, string>,
    assetPublicIds: Set<string>,
    bundleContentHashes: Map<string, string>,
  |}) {
    this._graph = graph;
    this._assetPublicIds = assetPublicIds;
    this._publicIdByAssetId = publicIdByAssetId;
    this._bundleContentHashes = bundleContentHashes;
  }

  static fromAssetGraph(
    assetGraph: AssetGraph,
    publicIdByAssetId: Map<string, string> = new Map(),
    assetPublicIds: Set<string> = new Set(),
  ): BundleGraph {
    let graph = new Graph<BundleGraphNode, BundleGraphEdgeTypes>();

    let rootNode = assetGraph.getRootNode();
    invariant(rootNode != null && rootNode.type === 'root');
    graph.setRootNode(rootNode);

    let assetGroupIds = new Set();
    for (let [, node] of assetGraph.nodes) {
      if (node.type === 'asset') {
        let {id: assetId} = node.value;
        // Generate a new, short public id for this asset to use.
        // If one already exists, use it.
        let publicId = publicIdByAssetId.get(assetId);
        if (publicId == null) {
          publicId = getPublicId(assetId, existing =>
            assetPublicIds.has(existing),
          );
          publicIdByAssetId.set(assetId, publicId);
          assetPublicIds.add(publicId);
        }
      }

      // Don't copy over asset groups into the bundle graph.
      if (node.type === 'asset_group') {
        assetGroupIds.add(node.id);
      } else {
        graph.addNode(node);
      }
    }

    for (let edge of assetGraph.getAllEdges()) {
      let fromIds;
      if (assetGroupIds.has(edge.from)) {
        fromIds = [...assetGraph.inboundEdges.getEdges(edge.from, null)];
      } else {
        fromIds = [edge.from];
      }

      for (let from of fromIds) {
        if (assetGroupIds.has(edge.to)) {
          for (let to of assetGraph.outboundEdges.getEdges(edge.to, null)) {
            graph.addEdge(from, to);
          }
        } else {
          graph.addEdge(from, edge.to);
        }
      }
    }

    return new BundleGraph({
      graph,
      assetPublicIds,
      bundleContentHashes: new Map(),
      publicIdByAssetId,
    });
  }

  serialize(): SerializedBundleGraph {
    return {
      $$raw: true,
      graph: this._graph.serialize(),
      assetPublicIds: this._assetPublicIds,
      bundleContentHashes: this._bundleContentHashes,
      publicIdByAssetId: this._publicIdByAssetId,
    };
  }

  static deserialize(serialized: SerializedBundleGraph): BundleGraph {
    return new BundleGraph({
      graph: Graph.deserialize(serialized.graph),
      assetPublicIds: serialized.assetPublicIds,
      bundleContentHashes: serialized.bundleContentHashes,
      publicIdByAssetId: serialized.publicIdByAssetId,
    });
  }

  addAssetGraphToBundle(
    asset: Asset,
    bundle: Bundle,
    shouldSkipDependency: Dependency => boolean = d =>
      this.isDependencySkipped(d),
  ) {
    // The root asset should be reached directly from the bundle in traversal.
    // Its children will be traversed from there.
    this._graph.addEdge(bundle.id, asset.id);
    this._graph.traverse((node, _, actions) => {
      if (node.type === 'bundle_group') {
        actions.skipChildren();
        return;
      }

      if (node.type === 'dependency' && shouldSkipDependency(node.value)) {
        actions.skipChildren();
        return;
      }

      if (node.type === 'asset' && !this.bundleHasAsset(bundle, node.value)) {
        bundle.stats.size += node.value.stats.size;
      }

      if (node.type === 'asset' || node.type === 'dependency') {
        this._graph.addEdge(bundle.id, node.id, 'contains');
      }

      if (node.type === 'dependency') {
        for (let bundleGroupNode of this._graph
          .getNodesConnectedFrom(node)
          .filter(node => node.type === 'bundle_group')) {
          invariant(bundleGroupNode.type === 'bundle_group');
          this._graph.addEdge(bundle.id, bundleGroupNode.id, 'bundle');
        }
      }
    }, nullthrows(this._graph.getNode(asset.id)));
    this._bundleContentHashes.delete(bundle.id);
  }

  addEntryToBundle(
    asset: Asset,
    bundle: Bundle,
    shouldSkipDependency?: Dependency => boolean,
  ) {
    this.addAssetGraphToBundle(asset, bundle, shouldSkipDependency);
    if (!bundle.entryAssetIds.includes(asset.id)) {
      bundle.entryAssetIds.push(asset.id);
    }
  }

  internalizeAsyncDependency(bundle: Bundle, dependency: Dependency) {
    if (!dependency.isAsync) {
      throw new Error('Expected an async dependency');
    }

    this._graph.addEdge(bundle.id, dependency.id, 'internal_async');
    this.removeExternalDependency(bundle, dependency);
  }

  isDependencySkipped(dependency: Dependency): boolean {
    let node = this._graph.getNode(dependency.id);
    invariant(node && node.type === 'dependency');
    return !!node.hasDeferred || node.excluded;
  }

  getParentBundlesOfBundleGroup(bundleGroup: BundleGroup): Array<Bundle> {
    return this._graph
      .getNodesConnectedTo(
        nullthrows(this._graph.getNode(getBundleGroupId(bundleGroup))),
        'bundle',
      )
      .filter(node => node.type === 'bundle')
      .map(node => {
        invariant(node.type === 'bundle');
        return node.value;
      });
  }

  resolveAsyncDependency(
    dependency: Dependency,
    bundle: ?Bundle,
  ): ?(
    | {|type: 'bundle_group', value: BundleGroup|}
    | {|type: 'asset', value: Asset|}
  ) {
    if (
      bundle != null &&
      this._graph.hasEdge(bundle.id, dependency.id, 'internal_async')
    ) {
      let resolved = this.getDependencyResolution(dependency, bundle);
      if (resolved == null) {
        return;
      } else {
        return {
          type: 'asset',
          value: resolved,
        };
      }
    }

    let node = this._graph
      .getNodesConnectedFrom(nullthrows(this._graph.getNode(dependency.id)))
      .find(node => node.type === 'bundle_group');

    if (node == null) {
      return;
    }

    invariant(node.type === 'bundle_group');
    return {
      type: 'bundle_group',
      value: node.value,
    };
  }

  getReferencedBundle(dependency: Dependency, fromBundle: Bundle): ?Bundle {
    // If this dependency is async, there will be a bundle group attached to it.
    let node = this._graph
      .getNodesConnectedFrom(nullthrows(this._graph.getNode(dependency.id)))
      .find(node => node.type === 'bundle_group');

    if (node != null) {
      invariant(node.type === 'bundle_group');
      return this.getBundlesInBundleGroup(node.value).find(b => {
        let mainEntryId = b.entryAssetIds[b.entryAssetIds.length - 1];
        return mainEntryId != null && node.value.entryAssetId === mainEntryId;
      });
    }

    // Otherwise, it may be a reference to another asset in the same bundle group.
    // Resolve the dependency to an asset, and look for it in one of the referenced bundles.
    let referencedBundles = this.getReferencedBundles(fromBundle);
    let referenced = this._graph
      .getNodesConnectedFrom(
        nullthrows(this._graph.getNode(dependency.id)),
        'references',
      )
      .find(node => node.type === 'asset');

    if (referenced != null) {
      invariant(referenced.type === 'asset');
      return referencedBundles.find(b =>
        this.bundleHasAsset(b, referenced.value),
      );
    }
  }

  removeAssetGraphFromBundle(asset: Asset, bundle: Bundle) {
    // Remove all contains edges from the bundle to the nodes in the asset's
    // subgraph.
    this._graph.traverse((node, context, actions) => {
      if (node.type === 'bundle_group') {
        actions.skipChildren();
        return;
      }

      if (node.type === 'asset' || node.type === 'dependency') {
        if (
          this._graph.hasEdge(bundle.id, node.id, 'contains') &&
          (node.type !== 'asset' ||
            this.isAssetReachableFromBundle(node.value, bundle))
        ) {
          this._graph.removeEdge(
            bundle.id,
            node.id,
            'contains',
            // Removing this contains edge should not orphan the connected node. This
            // is disabled for performance reasons as these edges are removed as part
            // of a traversal, and checking for orphans becomes quite expensive in
            // aggregate.
            false /* removeOrphans */,
          );
          if (node.type === 'asset') {
            bundle.stats.size -= asset.stats.size;
          }
        } else {
          actions.skipChildren();
        }
      }

      if (node.type === 'dependency') {
        this.removeExternalDependency(bundle, node.value);
      }
    }, nullthrows(this._graph.getNode(asset.id)));

    // Remove the untyped edge from the bundle to the entry.
    if (this._graph.hasEdge(bundle.id, asset.id)) {
      this._graph.removeEdge(bundle.id, asset.id);
    }

    // Remove bundle node if it no longer has any entry assets
    let bundleNode = nullthrows(this._graph.getNode(bundle.id));
    if (this._graph.getNodesConnectedFrom(bundleNode).length === 0) {
      this.removeBundle(bundle);
    }

    this._bundleContentHashes.delete(bundle.id);
  }

  removeBundle(bundle: Bundle) {
    // Remove bundle node if it no longer has any entry assets
    let bundleNode = nullthrows(this._graph.getNode(bundle.id));

    let bundleGroupNodes = this._graph.getNodesConnectedTo(
      bundleNode,
      'bundle',
    );
    this._graph.removeNode(bundleNode);

    // Remove bundle group node if it no longer has any bundles
    for (let bundleGroupNode of bundleGroupNodes) {
      invariant(bundleGroupNode.type === 'bundle_group');
      let bundleGroup = bundleGroupNode.value;

      let index = bundleGroup.bundleIds.indexOf(bundle.id);
      invariant(index >= 0);
      bundleGroup.bundleIds.splice(index, 1);

      if (
        // If the bundle group's entry asset belongs to this bundle, the group
        // was created because of this bundle. Remove the group.
        bundle.entryAssetIds.includes(bundleGroup.entryAssetId) ||
        // If the bundle group is now empty, remove it.
        this.getBundlesInBundleGroup(bundleGroup).length === 0
      ) {
        this.removeBundleGroup(bundleGroup);
      }
    }

    this._bundleContentHashes.delete(bundle.id);
  }

  removeBundleGroup(bundleGroup: BundleGroup) {
    let bundleGroupNode = nullthrows(
      this._graph.getNode(getBundleGroupId(bundleGroup)),
    );
    invariant(bundleGroupNode.type === 'bundle_group');

    let bundlesInGroup = this.getBundlesInBundleGroup(bundleGroupNode.value);
    for (let bundle of bundlesInGroup) {
      if (this.getBundleGroupsContainingBundle(bundle).length === 1) {
        this.removeBundle(bundle);
      }
    }

    // This function can be reentered through removeBundle above. In this case,
    // the node may already been removed.
    if (this._graph.hasNode(bundleGroupNode.id)) {
      this._graph.removeNode(bundleGroupNode);
    }

    assert(
      bundlesInGroup.every(
        bundle => this.getBundleGroupsContainingBundle(bundle).length > 0,
      ),
    );
  }

  removeExternalDependency(bundle: Bundle, dependency: Dependency) {
    for (let bundleGroupNode of this._graph
      .getNodesConnectedFrom(nullthrows(this._graph.getNode(dependency.id)))
      .filter(node => node.type === 'bundle_group')) {
      let inboundDependencies = this._graph
        .getNodesConnectedTo(bundleGroupNode)
        .filter(node => node.type === 'dependency')
        .map(node => {
          invariant(node.type === 'dependency');
          return node.value;
        });

      // If every inbound dependency to this bundle group does not belong to this bundle,
      // or the dependency is internal to the bundle, then the connection between
      // this bundle and the group is safe to remove.
      if (
        inboundDependencies.every(
          dependency =>
            !this.bundleHasDependency(bundle, dependency) ||
            this._graph.hasEdge(bundle.id, dependency.id, 'internal_async'),
        )
      ) {
        this._graph.removeEdge(bundle.id, bundleGroupNode.id, 'bundle');
      }
    }
  }

  createAssetReference(dependency: Dependency, asset: Asset): void {
    this._graph.addEdge(dependency.id, asset.id, 'references');
    if (this._graph.hasEdge(dependency.id, asset.id)) {
      this._graph.removeEdge(dependency.id, asset.id);
    }
  }

  createBundleReference(from: Bundle, to: Bundle): void {
    this._graph.addEdge(from.id, to.id, 'references');
  }

  findBundlesWithAsset(asset: Asset): Array<Bundle> {
    return this._graph
      .getNodesConnectedTo(
        nullthrows(this._graph.getNode(asset.id)),
        'contains',
      )
      .filter(node => node.type === 'bundle')
      .map(node => {
        invariant(node.type === 'bundle');
        return node.value;
      });
  }

  findBundlesWithDependency(dependency: Dependency): Array<Bundle> {
    return this._graph
      .getNodesConnectedTo(
        nullthrows(this._graph.getNode(dependency.id)),
        'contains',
      )
      .filter(node => node.type === 'bundle')
      .map(node => {
        invariant(node.type === 'bundle');
        return node.value;
      });
  }

  getDependencyAssets(dependency: Dependency): Array<Asset> {
    let dependencyNode = nullthrows(this._graph.getNode(dependency.id));
    return this._graph
      .getNodesConnectedFrom(dependencyNode)
      .filter(node => node.type === 'asset')
      .map(node => {
        invariant(node.type === 'asset');
        return node.value;
      });
  }

  getDependencyResolution(dep: Dependency, bundle: ?Bundle): ?Asset {
    let depNode = this._graph.getNode(dep.id);
    if (!depNode) {
      return null;
    }

    let assets = this.getDependencyAssets(dep);
    let firstAsset = assets[0];
    let resolved =
      // If no bundle is specified, use the first concrete asset.
      bundle == null
        ? firstAsset
        : // Otherwise, find the first asset that belongs to this bundle.
          assets.find(asset => this.bundleHasAsset(bundle, asset)) ||
          firstAsset;

    // If a resolution still hasn't been found, return the first referenced asset.
    if (resolved == null) {
      this._graph.traverse(
        (node, _, traversal) => {
          if (node.type === 'asset') {
            resolved = node.value;
            traversal.stop();
          } else if (node.id !== dep.id) {
            traversal.skipChildren();
          }
        },
        depNode,
        'references',
      );
    }

    return resolved;
  }

  getDependencies(asset: Asset): Array<Dependency> {
    let node = this._graph.getNode(asset.id);
    if (!node) {
      throw new Error('Asset not found');
    }

    return this._graph.getNodesConnectedFrom(node).map(node => {
      invariant(node.type === 'dependency');
      return node.value;
    });
  }

  traverseAssets<TContext>(
    bundle: Bundle,
    visit: GraphVisitor<Asset, TContext>,
  ): ?TContext {
    return this.traverseBundle(
      bundle,
      mapVisitor(node => (node.type === 'asset' ? node.value : null), visit),
    );
  }

  isAssetReferenced(asset: Asset): boolean {
    return (
      this._graph.getNodesConnectedTo(
        nullthrows(this._graph.getNode(asset.id)),
        'references',
      ).length > 0
    );
  }

  isAssetReferencedByDependant(
    bundle: Bundle,
    asset: Asset,
    visitedBundles: Set<Bundle> = new Set(),
  ): boolean {
    let dependencies = this._graph
      .getNodesConnectedTo(nullthrows(this._graph.getNode(asset.id)))
      .filter(node => node.type === 'dependency')
      .map(node => {
        invariant(node.type === 'dependency');
        return node.value;
      });

    const bundleHasReference = (bundle: Bundle) => {
      return (
        !this.bundleHasAsset(bundle, asset) &&
        dependencies.some(dependency =>
          this.bundleHasDependency(bundle, dependency),
        )
      );
    };

    let isReferenced = false;
    this.traverseBundles((descendant, _, actions) => {
      if (visitedBundles.has(descendant)) {
        actions.skipChildren();
        return;
      }

      visitedBundles.add(descendant);
      if (
        descendant.type !== bundle.type ||
        descendant.env.context !== bundle.env.context
      ) {
        actions.skipChildren();
        return;
      }

      if (descendant !== bundle && bundleHasReference(descendant)) {
        isReferenced = true;
        actions.stop();
        return;
      }

      let similarSiblings = this.getSiblingBundles(descendant).filter(
        sibling =>
          sibling.type === bundle.type &&
          sibling.env.context === bundle.env.context,
      );
      if (
        similarSiblings.some(
          sibling =>
            bundleHasReference(sibling) ||
            this.isAssetReferencedByDependant(sibling, asset, visitedBundles),
        )
      ) {
        isReferenced = true;
        actions.stop();
        return;
      }
    }, bundle);

    return isReferenced;
  }

  hasParentBundleOfType(bundle: Bundle, type: string): boolean {
    let parents = this.getParentBundles(bundle);
    return parents.length > 0 && parents.every(parent => parent.type === type);
  }

  getParentBundles(bundle: Bundle): Array<Bundle> {
    return unique(
      flatMap(
        this._graph.getNodesConnectedTo(
          nullthrows(this._graph.getNode(bundle.id)),
          'bundle',
        ),
        bundleGroupNode =>
          this._graph
            .getNodesConnectedTo(bundleGroupNode, 'bundle')
            // Entry bundle groups have the root node as their parent
            .filter(node => node.type !== 'root'),
      ).map(node => {
        invariant(node.type === 'bundle');
        return node.value;
      }),
    );
  }

  isAssetReachableFromBundle(asset: Asset, bundle: Bundle): boolean {
    // For an asset to be reachable from a bundle, it must either exist in a sibling bundle,
    // or in an ancestor bundle group reachable from all parent bundles.
    let bundleGroups = this.getBundleGroupsContainingBundle(bundle);
    return bundleGroups.every(bundleGroup => {
      // If the asset is in any sibling bundles of the original bundle, it is reachable.
      let bundles = this.getBundlesInBundleGroup(bundleGroup);
      if (
        bundles.some(b => b.id !== bundle.id && this.bundleHasAsset(b, asset))
      ) {
        return true;
      }

      // Get a list of parent bundle nodes pointing to the bundle group
      let parentBundleNodes = this._graph.getNodesConnectedTo(
        nullthrows(this._graph.getNode(getBundleGroupId(bundleGroup))),
        'bundle',
      );

      // Check that every parent bundle has a bundle group in its ancestry that contains the asset.
      return parentBundleNodes.every(bundleNode => {
        let inBundle = false;

        this._graph.traverseAncestors(
          bundleNode,
          (node, ctx, actions) => {
            if (node.type === 'bundle_group') {
              let childBundles = this.getBundlesInBundleGroup(node.value);
              if (
                childBundles.some(
                  b => b.id !== bundle.id && this.bundleHasAsset(b, asset),
                )
              ) {
                inBundle = true;
                actions.stop();
              }
            }

            // Don't deduplicate when context changes
            if (
              node.type === 'bundle' &&
              node.value.env.context !== bundle.env.context
            ) {
              actions.skipChildren();
            }
          },
          'bundle',
        );

        return inBundle;
      });
    });
  }

  findReachableBundleWithAsset(bundle: Bundle, asset: Asset): ?Bundle {
    let bundleGroups = this.getBundleGroupsContainingBundle(bundle);

    for (let bundleGroup of bundleGroups) {
      // If the asset is in any sibling bundles, return that bundle.
      let bundles = this.getBundlesInBundleGroup(bundleGroup).reverse();
      let res = bundles.find(
        b => b.id !== bundle.id && this.bundleHasAsset(b, asset),
      );
      if (res != null) {
        return res;
      }

      // Get a list of parent bundle nodes pointing to the bundle group
      let parentBundleNodes = this._graph.getNodesConnectedTo(
        nullthrows(this._graph.getNode(getBundleGroupId(bundleGroup))),
        'bundle',
      );

      // Find the nearest ancestor bundle that includes the asset.
      for (let bundleNode of parentBundleNodes) {
        this._graph.traverseAncestors(
          bundleNode,
          (node, ctx, actions) => {
            if (node.type === 'bundle_group') {
              let childBundles = this.getBundlesInBundleGroup(
                node.value,
              ).reverse();

              res = childBundles.find(
                b => b.id !== bundle.id && this.bundleHasAsset(b, asset),
              );
              if (res != null) {
                actions.stop();
              }
            }

            // Stop when context changes
            if (
              node.type === 'bundle' &&
              node.value.env.context !== bundle.env.context
            ) {
              actions.skipChildren();
            }
          },
          'bundle',
        );

        if (res != null) {
          return res;
        }
      }
    }
  }

  traverseBundle<TContext>(
    bundle: Bundle,
    visit: GraphVisitor<AssetNode | DependencyNode, TContext>,
  ): ?TContext {
    let entries = true;

    // A modified DFS traversal which traverses entry assets in the same order
    // as their ids appear in `bundle.entryAssetIds`.
    return this._graph.dfs({
      visit: mapVisitor((node, actions) => {
        if (node.id === bundle.id) {
          return;
        }

        if (node.type === 'dependency' || node.type === 'asset') {
          if (this._graph.hasEdge(bundle.id, node.id, 'contains')) {
            return node;
          }
        }

        actions.skipChildren();
      }, visit),
      startNode: nullthrows(this._graph.getNode(bundle.id)),
      getChildren: node => {
        let children = this._graph.getNodesConnectedFrom(nullthrows(node));
        let sorted =
          entries && bundle.entryAssetIds.length > 0
            ? children.sort((a, b) => {
                let aIndex = bundle.entryAssetIds.indexOf(a.id);
                let bIndex = bundle.entryAssetIds.indexOf(b.id);

                if (aIndex === bIndex) {
                  // If both don't exist in the entry asset list, or
                  // otherwise have the same index.
                  return 0;
                } else if (aIndex === -1) {
                  return 1;
                } else if (bIndex === -1) {
                  return -1;
                }

                return aIndex - bIndex;
              })
            : children;

        entries = false;
        return sorted;
      },
    });
  }

  traverseContents<TContext>(
    visit: GraphVisitor<AssetNode | DependencyNode, TContext>,
  ): ?TContext {
    return this._graph.filteredTraverse(
      node =>
        node.type === 'asset' || node.type === 'dependency' ? node : null,
      visit,
    );
  }

  getChildBundles(bundle: Bundle): Array<Bundle> {
    let bundles = [];
    this.traverseBundles((b, _, actions) => {
      if (bundle.id === b.id) {
        return;
      }

      bundles.push(b);
      actions.skipChildren();
    }, bundle);
    return bundles;
  }

  traverseBundles<TContext>(
    visit: GraphVisitor<Bundle, TContext>,
    startBundle: ?Bundle,
  ): ?TContext {
    return this._graph.filteredTraverse(
      node => (node.type === 'bundle' ? node.value : null),
      visit,
      startBundle ? nullthrows(this._graph.getNode(startBundle.id)) : null,
      'bundle',
    );
  }

  getBundles(): Array<Bundle> {
    let bundles = [];
    this.traverseBundles(bundle => {
      bundles.push(bundle);
    });

    return bundles;
  }

  getTotalSize(asset: Asset): number {
    let size = 0;
    this._graph.traverse((node, _, actions) => {
      if (node.type === 'bundle_group') {
        actions.skipChildren();
        return;
      }

      if (node.type === 'asset') {
        size += node.value.stats.size;
      }
    }, nullthrows(this._graph.getNode(asset.id)));
    return size;
  }

  getBundleGroupsContainingBundle(bundle: Bundle): Array<BundleGroup> {
    return this._graph
      .getNodesConnectedTo(nullthrows(this._graph.getNode(bundle.id)), 'bundle')
      .filter(node => node.type === 'bundle_group')
      .map(node => {
        invariant(node.type === 'bundle_group');
        return node.value;
      });
  }

  getBundlesInBundleGroup(bundleGroup: BundleGroup): Array<Bundle> {
    return bundleGroup.bundleIds
      .map(id => {
        let b = nullthrows(this._graph.getNode(id));
        invariant(b.type === 'bundle');
        return b.value;
      })
      .reverse();
  }

  getSiblingBundles(bundle: Bundle): Array<Bundle> {
    let siblings = new Set();

    let bundleGroups = this.getBundleGroupsContainingBundle(bundle);
    for (let bundleGroup of bundleGroups) {
      let bundles = this.getBundlesInBundleGroup(bundleGroup);
      for (let b of bundles) {
        if (b.id !== bundle.id) {
          siblings.add(b);
        }
      }
    }

    return [...siblings];
  }

  getReferencedBundles(bundle: Bundle): Array<Bundle> {
    return this._graph
      .getNodesConnectedFrom(
        nullthrows(this._graph.getNode(bundle.id)),
        'references',
      )
      .filter(node => node.type === 'bundle')
      .map(node => {
        invariant(node.type === 'bundle');
        return node.value;
      });
  }

  getIncomingDependencies(asset: Asset): Array<Dependency> {
    let node = this._graph.getNode(asset.id);
    if (!node) {
      return [];
    }

    // Dependencies can be a a parent node via an untyped edge (like in the AssetGraph but without AssetGroups)
    // or they can be parent nodes via a 'references' edge
    return (
      this._graph
        // $FlowFixMe
        .getNodesConnectedTo(node, ALL_EDGE_TYPES)
        .filter(n => n.type === 'dependency')
        .map(n => {
          invariant(n.type === 'dependency');
          return n.value;
        })
    );
  }

  bundleHasAsset(bundle: Bundle, asset: Asset): boolean {
    return this._graph.hasEdge(bundle.id, asset.id, 'contains');
  }

  bundleHasDependency(bundle: Bundle, dependency: Dependency): boolean {
    return this._graph.hasEdge(bundle.id, dependency.id, 'contains');
  }

  filteredTraverse<TValue, TContext>(
    bundle: Bundle,
    filter: (BundleGraphNode, TraversalActions) => ?TValue,
    visit: GraphVisitor<TValue, TContext>,
  ): ?TContext {
    return this._graph.filteredTraverse(
      filter,
      visit,
      nullthrows(this._graph.getNode(bundle.id)),
    );
  }

  resolveSymbol(
    asset: Asset,
    symbol: Symbol,
    boundary: ?Bundle,
  ): InternalSymbolResolution {
    let assetOutside = boundary && !this.bundleHasAsset(boundary, asset);

    let identifier = asset.symbols?.get(symbol)?.local;
    if (symbol === '*') {
      return {
        asset,
        exportSymbol: '*',
        symbol: identifier ?? null,
        loc: asset.symbols?.get(symbol)?.loc,
      };
    }

    let found = false;
    let skipped = false;
    let deps = this.getDependencies(asset).reverse();
    let potentialResults = [];
    for (let dep of deps) {
      let depSymbols = dep.symbols;
      if (!depSymbols) {
        found = true;
        continue;
      }
      // If this is a re-export, find the original module.
      let symbolLookup = new Map(
        [...depSymbols].map(([key, val]) => [val.local, key]),
      );
      let depSymbol = symbolLookup.get(identifier);
      if (depSymbol != null) {
        let resolved = this.getDependencyResolution(dep);
        if (!resolved) {
          // External module
          return {
            asset,
            exportSymbol: symbol,
            symbol: identifier,
            loc: asset.symbols?.get(symbol)?.loc,
          };
        }

        if (assetOutside) {
          // We found the symbol, but `asset` is outside, return `asset` and the original symbol
          found = true;
          break;
        }

        if (this.isDependencySkipped(dep)) {
          // We found the symbol and `dep` was skipped
          skipped = true;
          break;
        }

        let {
          asset: resolvedAsset,
          symbol: resolvedSymbol,
          exportSymbol,
          loc,
        } = this.resolveSymbol(resolved, depSymbol, boundary);

        if (!loc) {
          // Remember how we got there
          loc = asset.symbols?.get(symbol)?.loc;
        }

        return {
          asset: resolvedAsset,
          symbol: resolvedSymbol,
          exportSymbol,
          loc,
        };
      }

      // If this module exports wildcards, resolve the original module.
      // Default exports are excluded from wildcard exports.
      // Wildcard reexports are never listed in the reexporting asset's symbols.
      if (
        identifier == null &&
        depSymbols.get('*')?.local === '*' &&
        symbol !== 'default'
      ) {
        let resolved = this.getDependencyResolution(dep);
        if (!resolved) {
          continue;
        }
        let result = this.resolveSymbol(resolved, symbol, boundary);

        // We found the symbol
        if (result.symbol != undefined) {
          if (assetOutside) {
            // ..., but `asset` is outside, return `asset` and the original symbol
            found = true;
            break;
          }
          if (this.isDependencySkipped(dep)) {
            // We found the symbol and `dep` was skipped
            skipped = true;
            break;
          }

          return {
            asset: result.asset,
            symbol: result.symbol,
            exportSymbol: result.exportSymbol,
            loc: resolved.symbols?.get(symbol)?.loc,
          };
        }
        if (result.symbol === null) {
          found = true;
          if (boundary && !this.bundleHasAsset(boundary, result.asset)) {
            // If the returned asset is outside (and it's the first asset that is outside), return it.
            if (!assetOutside) {
              return {
                asset: result.asset,
                symbol: result.symbol,
                exportSymbol: result.exportSymbol,
                loc: resolved.symbols?.get(symbol)?.loc,
              };
            } else {
              // Otherwise the original asset will be returned at the end.
              break;
            }
          } else {
            // We didn't find it in this dependency, but it might still be there: bailout.
            // Continue searching though, with the assumption that there are no conficting reexports
            // and there might be a another (re)export (where we might statically find the symbol).
            potentialResults.push({
              asset: result.asset,
              symbol: result.symbol,
              exportSymbol: result.exportSymbol,
              loc: resolved.symbols?.get(symbol)?.loc,
            });
          }
        }
      }
    }

    // We didn't find the exact symbol...
    if (potentialResults.length == 1) {
      // ..., but if it does exist, it has to be behind this one reexport.
      return potentialResults[0];
    } else {
      // ... and there is no single reexport, but `bailout` tells us if it might still be exported.
      return {
        asset,
        exportSymbol: symbol,
        symbol: skipped
          ? false
          : found
          ? null
          : identifier ?? (asset.symbols?.has('*') ? null : undefined),
        loc: asset.symbols?.get(symbol)?.loc,
      };
    }
  }
  getAssetById(id: string): Asset {
    let node = this._graph.getNode(id);
    if (node == null) {
      throw new Error('Node not found');
    } else if (node.type !== 'asset') {
      throw new Error('Node was not an asset');
    }

    return node.value;
  }

  getAssetPublicId(asset: Asset): string {
    let publicId = this._publicIdByAssetId.get(asset.id);
    if (publicId == null) {
      throw new Error("Asset or it's public id not found");
    }

    return publicId;
  }

  getExportedSymbols(
    asset: Asset,
    boundary: ?Bundle,
  ): Array<InternalExportSymbolResolution> {
    if (!asset.symbols) {
      return [];
    }

    let symbols = [];

    for (let symbol of asset.symbols.keys()) {
      symbols.push({
        ...this.resolveSymbol(asset, symbol, boundary),
        exportAs: symbol,
      });
    }

    let deps = this.getDependencies(asset);
    for (let dep of deps) {
      let depSymbols = dep.symbols;
      if (!depSymbols) continue;

      if (depSymbols.get('*')?.local === '*') {
        let resolved = this.getDependencyResolution(dep);
        if (!resolved) continue;
        let exported = this.getExportedSymbols(resolved, boundary)
          .filter(s => s.exportSymbol !== 'default')
          .map(s => ({...s, exportAs: s.exportSymbol}));
        symbols.push(...exported);
      }
    }

    return symbols;
  }

  getContentHash(bundle: Bundle): string {
    let existingHash = this._bundleContentHashes.get(bundle.id);
    if (existingHash != null) {
      return existingHash;
    }

    let hash = crypto.createHash('md5');
    // TODO: sort??
    this.traverseAssets(bundle, asset => {
      hash.update(
        [
          this.getAssetPublicId(asset),
          asset.outputHash,
          asset.filePath,
          querystring.stringify(asset.query),
          asset.type,
          asset.uniqueKey,
        ].join(':'),
      );
    });

    let hashHex = hash.digest('hex');
    this._bundleContentHashes.set(bundle.id, hashHex);
    return hashHex;
  }

  getInlineBundles(bundle: Bundle): Array<Bundle> {
    let bundles = [];
    let seen = new Set();
    let addReferencedBundles = bundle => {
      if (seen.has(bundle.id)) {
        return;
      }

      seen.add(bundle.id);

      let referencedBundles = this.getReferencedBundles(bundle);
      for (let referenced of referencedBundles) {
        if (referenced.isInline) {
          bundles.push(referenced);
          addReferencedBundles(referenced);
        }
      }
    };

    addReferencedBundles(bundle);

    this.traverseBundles((childBundle, _, traversal) => {
      if (childBundle.isInline) {
        bundles.push(childBundle);
      } else if (childBundle.id !== bundle.id) {
        traversal.skipChildren();
      }
    }, bundle);

    return bundles;
  }

  getHash(bundle: Bundle): string {
    let hash = crypto.createHash('md5');
    hash.update(bundle.id);
    hash.update(this.getContentHash(bundle));

    let inlineBundles = this.getInlineBundles(bundle);
    for (let inlineBundle of inlineBundles) {
      hash.update(this.getContentHash(inlineBundle));
    }

    for (let childBundle of this.getChildBundles(bundle)) {
      if (!childBundle.isInline) {
        hash.update(childBundle.id);
      }
    }

    hash.update(JSON.stringify(objectSortedEntriesDeep(bundle.env)));
    return hash.digest('hex');
  }

  getUsedSymbolsAsset(asset: Asset): $ReadOnlySet<Symbol> {
    let node = this._graph.getNode(asset.id);
    invariant(node && node.type === 'asset');
    return makeReadOnlySet(node.usedSymbols);
  }

  getUsedSymbolsDependency(dep: Dependency): $ReadOnlySet<Symbol> {
    let node = this._graph.getNode(dep.id);
    invariant(node && node.type === 'dependency');
    return makeReadOnlySet(node.usedSymbolsUp);
  }

  merge(other: BundleGraph) {
    for (let [, node] of other._graph.nodes) {
      let existingNode = this._graph.getNode(node.id);
      if (existingNode != null) {
        // Merge symbols, recompute dep.exluded based on that
        if (existingNode.type === 'asset') {
          invariant(node.type === 'asset');
          existingNode.usedSymbols = new Set([
            ...existingNode.usedSymbols,
            ...node.usedSymbols,
          ]);
        } else if (existingNode.type === 'dependency') {
          invariant(node.type === 'dependency');
          existingNode.usedSymbolsDown = new Set([
            ...existingNode.usedSymbolsDown,
            ...node.usedSymbolsDown,
          ]);
          existingNode.usedSymbolsUp = new Set([
            ...existingNode.usedSymbolsUp,
            ...node.usedSymbolsUp,
          ]);

          existingNode.excluded =
            (existingNode.excluded || Boolean(existingNode.hasDeferred)) &&
            (node.excluded || Boolean(node.hasDeferred));
        }
      } else {
        this._graph.addNode(node);
      }
    }

    for (let edge of other._graph.getAllEdges()) {
      this._graph.addEdge(edge.from, edge.to, edge.type);
    }
  }
}
