/**
 * Graphology Reference Implementation
 * ====================================
 *
 * Reference implementation of the graphology specs.
 *
 * Note: Even if the implementation could beneficiate from an abstraction
 * over the object/map manipulation, it does not for performance reasons.
 */
import {EventEmitter} from 'events';

import {
  InvalidArgumentsGraphError,
  NotFoundGraphError,
  UsageGraphError
} from './errors';

import {
  INDICES,
  updateStructureIndex,
  clearEdgeFromStructureIndex,
  clearStructureIndex
} from './indices';

import {attachAttributesMethods} from './attributes';
import {attachEdgeIterationMethods} from './iteration/edges';
import {attachNeighborIterationMethods} from './iteration/neighbors';

import {
  serializeNode,
  serializeEdge,
  validateSerializedNode,
  validateSerializedEdge
} from './serialization';

import {
  assign,
  BasicSet,
  isBunch,
  isGraph,
  isPlainObject,
  overBunch,
  prettyPrint,
  privateProperty,
  readOnlyProperty,
  uuid
} from './utils';

// TODO: add method to check if edge is self loop?
// TODO: differentiate index structure for simple/multi for performance?
// TODO: dropEdge & dropEdges arity 2
// TODO: mergeNodeAttribute
// TODO: events
// TODO: finish options

/**
 * Enums.
 */
const TYPES = new BasicSet(['directed', 'undirected', 'mixed']),
      EMITTER_PROPS = new BasicSet(['domain', '_events', '_eventsCount', '_maxListeners']);

/**
 * Default options.
 */
const DEFAULTS = {
  allowSelfLoops: true,
  edgeKeyGenerator: uuid,
  map: false,
  multi: false,
  type: 'mixed'
};

/**
 * Graph class
 *
 * @constructor
 * @param  {Graph|Array<Array>} [data]    - Hydratation data.
 * @param  {object}             [options] - Options:
 * @param  {boolean}              [allowSelfLoops] - Allow self loops?
 * @param  {string}               [type]           - Type of the graph.
 * @param  {boolean}              [map]            - Allow references as keys?
 * @param  {boolean}              [multi]          - Allow parallel edges?
 *
 * @throws {Error} - Will throw if the arguments are not valid.
 */
export default class Graph extends EventEmitter {
  constructor(data, options) {
    super();

    //-- Solving options
    options = assign({}, DEFAULTS, options);

    // Enforcing options validity
    if (typeof options.edgeKeyGenerator !== 'function')
      throw new InvalidArgumentsGraphError(`Graph.constructor: invalid 'edgeKeyGenerator' option. Expecting a function but got "${options.map}".`);

    if (typeof options.map !== 'boolean')
      throw new InvalidArgumentsGraphError(`Graph.constructor: invalid 'map' option. Expecting a boolean but got "${options.map}".`);

    if (options.map && typeof Map !== 'function')
      throw new InvalidArgumentsGraphError('Graph.constructor: it seems you created a GraphMap instance while your current JavaScript engine does not support ES2015 Map objects.');

    if (typeof options.multi !== 'boolean')
      throw new InvalidArgumentsGraphError(`Graph.constructor: invalid 'multi' option. Expecting a boolean but got "${options.multi}".`);

    if (!TYPES.has(options.type))
      throw new InvalidArgumentsGraphError(`Graph.constructor: invalid 'type' option. Should be one of "mixed", "directed" or "undirected" but got "${options.type}".`);

    if (typeof options.allowSelfLoops !== 'boolean')
      throw new InvalidArgumentsGraphError(`Graph.constructor: invalid 'allowSelfLoops' option. Expecting a boolean but got "${options.allowSelfLoops}".`);

    //-- Private properties

    // Counters
    privateProperty(this, '_order', 0);
    privateProperty(this, '_size', 0);

    // Indexes
    privateProperty(this, '_nodes', options.map ? new Map() : {});
    privateProperty(this, '_edges', options.map ? new Map() : {});
    privateProperty(this, '_indices', {
      structure: {
        computed: false,
        synchronized: true
      },
      neighbors: {
        computed: false,
        synchronized: true
      }
    });

    // Options
    privateProperty(this, '_options', options);

    // Methods
    privateProperty(this, '_addEdge', this._addEdge);
    privateProperty(this, '_exportEdges', this._exportEdges);
    privateProperty(this, '_updateIndex', this._updateIndex);
    privateProperty(this, '_clearEdgeFromIndex', this._clearEdgeFromIndex);
    privateProperty(this, 'internals', this.internals);

    //-- Properties readers
    readOnlyProperty(this, 'order', () => this._order);
    readOnlyProperty(this, 'size', () => this._size);
    readOnlyProperty(this, 'map', () => this._options.map);
    readOnlyProperty(this, 'multi', () => this._options.multi);
    readOnlyProperty(this, 'type', () => this._options.type);
    readOnlyProperty(this, 'allowSelfLoops', () => this._options.allowSelfLoops);

    //-- Hydratation
    if (data)
      this.import(data);
  }

  /**---------------------------------------------------------------------------
   * Read
   **---------------------------------------------------------------------------
   */

  /**
   * Method returning whether the given node is found in the graph.
   *
   * @param  {any}     node - The node.
   * @return {boolean}
   */
  hasNode(node) {
    let nodeInGraph = false;

    if (this.map)
      nodeInGraph = this._nodes.has(node);
    else
      nodeInGraph = node in this._nodes;

    return nodeInGraph;
  }

  /**
   * Internal method returning a matching directed edge or undefined if no
   * matching edge was found.
   *
   * @param  {any}     source - The edge's source.
   * @param  {any}     target - The edge's target.
   * @return {any|undefined}
   */
  getDirectedEdge(source, target) {

    // We need to compute the 'structure' index for this
    this.computeIndex('structure');

    // If the node source or the target is not in the graph we break
    if (!this.hasNode(source) || !this.hasNode(target))
      return;

    // Is there a directed edge pointing towards target?
    const nodeData = this.map ?
      this._nodes.get(source) :
      this._nodes[source];

    const register = nodeData.out;

    if (!register)
      return;

    const edges = this.map ?
      (register.get(target)) :
      (register[target]);

    if (!edges)
      return;

    if (!edges.size)
      return;

    return this.map ? edges.values().next().value : edges.first();
  }

  /**
   * Internal method returning a matching undirected edge or undefined if no
   * matching edge was found.
   *
   * @param  {any}     source - The edge's source.
   * @param  {any}     target - The edge's target.
   * @return {any|undefined}
   */
  getUndirectedEdge(source, target) {

    // We need to compute the 'structure' index for this
    this.computeIndex('structure');

    // If the node source or the target is not in the graph we break
    if (!this.hasNode(source) || !this.hasNode(target))
      return;

    // Is there a directed edge pointing towards target?
    const nodeData = this.map ?
      this._nodes.get(source) :
      this._nodes[source];

    let register = nodeData.undirectedOut,
        edges;

    if (register)
      edges = this.map ?
        (register.get(target)) :
        (register[target]);

    register = nodeData.undirectedIn;

    if (!edges && register)
      edges = this.map ?
        (register.get(target)) :
        (register[target]);

    if (!edges)
      return;

    if (!edges.size)
      return;

    return this.map ? edges.values().next().value : edges.first();
  }

  /**
   * Method returning a matching edge (note that it will return the first
   * matching edge, starting with directed one then undirected), or undefined
   * if no matching edge was found.
   *
   * @param  {any}     source - The edge's source.
   * @param  {any}     target - The edge's target.
   * @return {any|undefined}
   */
  getEdge(source, target) {
    let edge;

    // First we try to find a directed edge
    if (this.type === 'mixed' || this.type === 'directed')
      edge = this.getDirectedEdge(source, target);

    if (edge)
      return edge;

    // Then we try to find an undirected edge
    if (this.type === 'mixed' || this.type === 'undirected')
    edge = this.getUndirectedEdge(source, target);

    return edge;
  }

  /**
   * Method returning whether the given directed edge is found in the graph.
   *
   * Arity 1:
   * @param  {any}     edge - The edge's key.
   *
   * Arity 2:
   * @param  {any}     source - The edge's source.
   * @param  {any}     target - The edge's target.
   *
   * @return {boolean}
   *
   * @throws {Error} - Will throw if the arguments are invalid.
   */
  hasDirectedEdge(source, target) {
    if (arguments.length === 1) {
      const edge = source;

      return (
        this.map ? this._edges.has(edge) : edge in this._edges &&
        this.directed(edge)
      );
    }
    else if (arguments.length === 2) {

      // We need to compute the 'structure' index for this
      this.computeIndex('structure');

      // If the node source or the target is not in the graph we break
      if (!this.hasNode(source) || !this.hasNode(target))
        return false;

      // Is there a directed edge pointing towards target?
      const nodeData = this.map ?
        this._nodes.get(source) :
        this._nodes[source];

      const register = nodeData.out;

      if (!register)
        return false;

      const edges = this.map ?
        (register.get(target)) :
        (register[target]);

      if (!edges)
        return false;

      return !!edges.size;
    }

    throw new InvalidArgumentsGraphError(`Graph.hasDirectedEdge: invalid arity (${arguments.length}, instead of 1 or 2). You can either ask for an edge id or for the existence of an edge between a source & a target.`);
  }

  /**
   * Method returning whether the given undirected edge is found in the graph.
   *
   * Arity 1:
   * @param  {any}     edge - The edge's key.
   *
   * Arity 2:
   * @param  {any}     source - The edge's source.
   * @param  {any}     target - The edge's target.
   *
   * @return {boolean}
   *
   * @throws {Error} - Will throw if the arguments are invalid.
   */
  hasUndirectedEdge(source, target) {
    if (arguments.length === 1) {
      const edge = source;

      return (
        this.map ? this._edges.has(edge) : edge in this._edges &&
        this.undirected(edge)
      );
    }
    else if (arguments.length === 2) {

      // We need to compute the 'structure' index for this
      this.computeIndex('structure');

      // If the node source or the target is not in the graph we break
      if (!this.hasNode(source) || !this.hasNode(target))
        return false;

      // Is there a directed edge pointing towards target?
      const nodeData = this.map ?
        this._nodes.get(source) :
        this._nodes[source];

      let register = nodeData.undirectedOut,
          edges;

      if (register)
        edges = this.map ?
          (register.get(target)) :
          (register[target]);

      register = nodeData.undirectedIn;

      if (!edges && register)
        edges = this.map ?
          (register.get(target)) :
          (register[target]);

      if (!edges)
        return false;

      return !!edges.size;
    }

    throw new InvalidArgumentsGraphError(`Graph.hasDirectedEdge: invalid arity (${arguments.length}, instead of 1 or 2). You can either ask for an edge id or for the existence of an edge between a source & a target.`);
  }

  /**
   * Method returning whether the given edge is found in the graph.
   *
   * Arity 1:
   * @param  {any}     edge - The edge's key.
   *
   * Arity 2:
   * @param  {any}     source - The edge's source.
   * @param  {any}     target - The edge's target.
   *
   * @return {boolean}
   *
   * @throws {Error} - Will throw if the arguments are invalid.
   */
  hasEdge(source, target) {

    if (arguments.length === 1) {
      const edge = source;

      return this.map ? this._edges.has(edge) : edge in this._edges;
    }
    else if (arguments.length === 2) {
      return (
        this.hasDirectedEdge(source, target) ||
        this.hasUndirectedEdge(source, target)
      );
    }

    throw new InvalidArgumentsGraphError(`Graph.hasEdge: invalid arity (${arguments.length}, instead of 1 or 2). You can either ask for an edge id or for the existence of an edge between a source & a target.`);
  }

  /**
   * Method returning the given node's in degree.
   *
   * @param  {any}     node      - The node's key.
   * @param  {boolean} allowSelfLoops - Count self-loops?
   * @return {number}            - The node's in degree.
   *
   * @throws {Error} - Will throw if the selfLoops arg is not boolean.
   * @throws {Error} - Will throw if the node isn't in the graph.
   */
  inDegree(node, selfLoops = true) {
    if (typeof selfLoops !== 'boolean')
      throw new InvalidArgumentsGraphError(`Graph.inDegree: Expecting a boolean but got "${selfLoops}" for the second parameter (allowing self-loops to be counted).`);

    if (!this.hasNode(node))
      throw new NotFoundGraphError(`Graph.inDegree: could not find the "${node}" node in the graph.`);

    const data = this.map ? this._nodes.get(node) : this._nodes[node];

    return data.inDegree + (selfLoops ? data.selfLoops : 0);
  }

  /**
   * Method returning the given node's out degree.
   *
   * @param  {any}     node      - The node's key.
   * @param  {boolean} selfLoops - Count self-loops?
   * @return {number}            - The node's out degree.
   *
   * @throws {Error} - Will throw if the selfLoops arg is not boolean.
   * @throws {Error} - Will throw if the node isn't in the graph.
   */
  outDegree(node, selfLoops = true) {
    if (typeof selfLoops !== 'boolean')
      throw new InvalidArgumentsGraphError(`Graph.outDegree: Expecting a boolean but got "${selfLoops}" for the second parameter (allowing self-loops to be counted).`);

    if (!this.hasNode(node))
      throw new NotFoundGraphError(`Graph.outDegree: could not find the "${node}" node in the graph.`);

    const data = this.map ? this._nodes.get(node) : this._nodes[node];

    return data.outDegree + (selfLoops ? data.selfLoops : 0);
  }

  /**
   * Method returning the given node's directed degree.
   *
   * @param  {any}     node      - The node's key.
   * @param  {boolean} selfLoops - Count self-loops?
   * @return {number}            - The node's directed degree.
   *
   * @throws {Error} - Will throw if the selfLoops arg is not boolean.
   * @throws {Error} - Will throw if the node isn't in the graph.
   */
  directedDegree(node, selfLoops = true) {
    if (typeof selfLoops !== 'boolean')
      throw new InvalidArgumentsGraphError(`Graph.directedDegree: Expecting a boolean but got "${selfLoops}" for the second parameter (allowing self-loops to be counted).`);

    if (!this.hasNode(node))
      throw new NotFoundGraphError(`Graph.directedDegree: could not find the "${node}" node in the graph.`);

    const data = this.map ? this._nodes.get(node) : this._nodes[node];

    return (
      data.outDegree + data.inDegree +
      (selfLoops ? data.selfLoops : 0)
    );
  }

  /**
   * Method returning the given node's undirected degree.
   *
   * @param  {any}     node      - The node's key.
   * @param  {boolean} selfLoops - Count self-loops?
   * @return {number}            - The node's undirected degree.
   *
   * @throws {Error} - Will throw if the selfLoops arg is not boolean.
   * @throws {Error} - Will throw if the node isn't in the graph.
   */
  undirectedDegree(node, selfLoops = true) {
    if (typeof selfLoops !== 'boolean')
      throw new InvalidArgumentsGraphError(`Graph.undirectedDegree: Expecting a boolean but got "${selfLoops}" for the second parameter (allowing self-loops to be counted).`);

    if (!this.hasNode(node))
      throw new NotFoundGraphError(`Graph.undirectedDegree: could not find the "${node}" node in the graph.`);

    const data = this.map ? this._nodes.get(node) : this._nodes[node];

    return (
      data.undirectedDegree +
      (selfLoops ? data.selfLoops : 0)
    );
  }

  /**
   * Method returning the given node's degree.
   *
   * @param  {any}     node      - The node's key.
   * @param  {boolean} selfLoops - Count self-loops?
   * @return {number}            - The node's degree.
   *
   * @throws {Error} - Will throw if the selfLoops arg is not boolean.
   * @throws {Error} - Will throw if the node isn't in the graph.
   */
  degree(node, selfLoops = true) {
    if (typeof selfLoops !== 'boolean')
      throw new InvalidArgumentsGraphError(`Graph.degree: Expecting a boolean but got "${selfLoops}" for the second parameter (allowing self-loops to be counted).`);

    if (!this.hasNode(node))
      throw new NotFoundGraphError(`Graph.degree: could not find the "${node}" node in the graph.`);

    const data = this.map ? this._nodes.get(node) : this._nodes[node];

    return (
      data.outDegree + data.inDegree + data.undirectedDegree +
      (selfLoops ? data.selfLoops : 0)
    );
  }

  /**
   * Method returning the given edge's source.
   *
   * @param  {any} edge - The edge's key.
   * @return {any}      - The edge's source.
   *
   * @throws {Error} - Will throw if the edge isn't in the graph.
   */
  source(edge) {
    if (!this.hasEdge(edge))
      throw new NotFoundGraphError(`Graph.source: could not find the "${edge}" edge in the graph.`);

    const source = this.map ?
      this._edges.get(edge).source :
      this._edges[edge].source;

    return source;
  }

  /**
   * Method returning the given edge's target.
   *
   * @param  {any} edge - The edge's key.
   * @return {any}      - The edge's target.
   *
   * @throws {Error} - Will throw if the edge isn't in the graph.
   */
  target(edge) {
    if (!this.hasEdge(edge))
      throw new NotFoundGraphError(`Graph.target: could not find the "${edge}" edge in the graph.`);

    const target = this.map ?
      this._edges.get(edge).target :
      this._edges[edge].target;

    return target;
  }

  /**
   * Method returning the given edge's extremities.
   *
   * @param  {any}   edge - The edge's key.
   * @return {array}      - The edge's extremities.
   *
   * @throws {Error} - Will throw if the edge isn't in the graph.
   */
  extremities(edge) {
    if (!this.hasEdge(edge))
      throw new NotFoundGraphError(`Graph.extremities: could not find the "${edge}" edge in the graph.`);

    return [this.source(edge), this.target(edge)];
  }

  /**
   * Given a node & an edge, returns the other extremity of the edge.
   *
   * @param  {any}   node - The node's key.
   * @param  {any}   edge - The edge's key.
   * @return {any}        - The related node.
   *
   * @throws {Error} - Will throw if either the node or the edge isn't in the graph.
   */
  relatedNode(node, edge) {
    if (!this.hasNode(node))
      throw new NotFoundGraphError(`Graph.relatedNode: could not find the "${node}" node in the graph.`);

    if (!this.hasEdge(edge))
      throw new NotFoundGraphError(`Graph.relatedNode: could not find the "${edge}" edge in the graph.`);

    const [node1, node2] = this.extremities(edge);

    return node === node1 ? node2 : node1;
  }

  /**
   * Method returning whether the given edge is undirected.
   *
   * @param  {any}     edge - The edge's key.
   * @return {boolean}
   *
   * @throws {Error} - Will throw if the edge isn't in the graph.
   */
  undirected(edge) {
    if (!this.hasEdge(edge))
      throw new NotFoundGraphError(`Graph.undirected: could not find the "${edge}" edge in the graph.`);

    const undirected = this.map ?
      this._edges.get(edge).undirected :
      this._edges[edge].undirected;

    return undirected;
  }

  /**
   * Method returning whether the given edge is directed.
   *
   * @param  {any}     edge - The edge's key.
   * @return {boolean}
   *
   * @throws {Error} - Will throw if the edge isn't in the graph.
   */
  directed(edge) {
    if (!this.hasEdge(edge))
      throw new NotFoundGraphError(`Graph.directed: could not find the "${edge}" edge in the graph.`);

    return !this.undirected(edge);
  }

  /**---------------------------------------------------------------------------
   * Mutation
   **---------------------------------------------------------------------------
   */

  /**
   * Method used to add a node to the graph.
   *
   * @param  {any}    node         - The node.
   * @param  {object} [attributes] - Optional attributes.
   * @return {any}                 - The node.
   *
   * @throws {Error} - Will throw if the given node already exist.
   * @throws {Error} - Will throw if the given attributes are not an object.
   */
  addNode(node, attributes) {
    if (arguments.length > 1 && !isPlainObject(attributes))
      throw new InvalidArgumentsGraphError(`Graph.addNode: invalid attributes. Expecting an object but got "${attributes}"`);

    if (this.hasNode(node))
      throw new UsageGraphError(`Graph.addNode: the "${node}" node already exist in the graph. You might want to check out the 'onDuplicateNode' option.`);

    // Protecting the attributes
    attributes = assign({}, attributes);

    const data = {
      attributes,
      selfLoops: 0
    };

    if (this.type === 'mixed' || this.type === 'directed') {
      data.inDegree = 0;
      data.outDegree = 0;
    }
    if (this.type === 'mixed' || this.type === 'undirected') {
      data.undirectedDegree = 0;
    }

    // Adding the node to internal register
    if (this.map)
      this._nodes.set(node, data);
    else
      this._nodes[node] = data;

    // Incrementing order
    this._order++;

    return node;
  }

  /**
   * Method used to add a nodes from a bunch.
   *
   * @param  {bunch}  bunch - The node.
   * @return {Graph}        - Returns itself for chaining.
   *
   * @throws {Error} - Will throw if the given bunch is not valid.
   */
  addNodesFrom(bunch) {
    if (!isBunch(bunch))
      throw new InvalidArgumentsGraphError(`Graph.addNodesFrom: invalid bunch provided ("${bunch}").`);

    overBunch(bunch, (error, node, attributes) => {
      this.addNode(node, attributes);
    });

    return this;
  }

  /**
   * Internal method used to add an arbitrary edge to the graph.
   *
   * @param  {string}  name         - Name of the child method for errors.
   * @param  {boolean} undirected   - Whether the edge is undirected.
   * @param  {any}     edge         - The edge's key.
   * @param  {any}     source       - The source node.
   * @param  {any}     target       - The target node.
   * @param  {object}  [attributes] - Optional attributes.
   * @return {any}                  - The edge.
   *
   * @throws {Error} - Will throw if the graph is undirected.
   * @throws {Error} - Will throw if the given attributes are not an object.
   * @throws {Error} - Will throw if source or target doesn't exist.
   * @throws {Error} - Will throw if the edge already exist.
   */
  _addEdge(name, undirected, edge, source, target, attributes) {

    if (!undirected && this.type === 'undirected')
      throw new UsageGraphError(`Graph.${name}: you cannot add a directed edge to an undirected graph. Use the #.addEdge or #.addUndirectedEdge instead.`);

    if (undirected && this.type === 'directed')
      throw new UsageGraphError(`Graph.${name}: you cannot add an undirected edge to a directed graph. Use the #.addEdge or #.addDirectedEdge instead.`);

    if (attributes && !isPlainObject(attributes))
      throw new InvalidArgumentsGraphError(`Graph.${name}: invalid attributes. Expecting an object but got "${attributes}"`);

    if (!this.hasNode(source))
      throw new NotFoundGraphError(`Graph.${name}: source node "${source}" not found.`);

    if (!this.hasNode(target))
      throw new NotFoundGraphError(`Graph.${name}: target node "${target}" not found.`);

    if (this.hasEdge(edge))
      throw new UsageGraphError(`Graph.${name}: the "${edge}" edge already exists in the graph.`);

    if (!this.allowSelfLoops && source === target)
      throw new UsageGraphError(`Graph.${name}: source & target are the same, thus creating a loop explicitly forbidden by this graph 'allowSelfLoops' option set to false.`);

    if (
      !this.multi &&
      (
        undirected ?
          this.hasUndirectedEdge(source, target) :
          this.hasDirectedEdge(source, target)
      )
    )
      throw new UsageGraphError(`Graph.${name}: an edge linking "${source}" to "${target}" already exists. If you really want to add multiple edges linking those nodes, you should create a multi graph by using the 'multi' option. The 'onDuplicateEdge' option might also interest you.`);

    // Protecting the attributes
    attributes = assign({}, attributes);

    // Storing some data
    const data = {
      undirected,
      attributes,
      source,
      target
    };

    if (this.map)
      this._edges.set(edge, data);
    else
      this._edges[edge] = data;

    // Incrementing size
    this._size++;

    // Incrementing node counters
    const sourceData = this.map ? this._nodes.get(source) : this._nodes[source],
          targetData = this.map ? this._nodes.get(target) : this._nodes[target];

    if (source === target) {
      sourceData.selfLoops++;
    }
    else {
      if (undirected) {
        sourceData.undirectedDegree++;
        targetData.undirectedDegree++;
      }
      else {
        sourceData.outDegree++;
        targetData.inDegree++;
      }
    }

    // Updating relevant indexes
    this._updateIndex('structure', edge, data);

    return edge;
  }

  /**
   * Method used to add an edge of the type of the graph or directed if the
   * graph is mixed using the given key.
   *
   * @param  {any}    edge         - The edge's key.
   * @param  {any}    source       - The source node.
   * @param  {any}    target       - The target node.
   * @param  {object} [attributes] - Optional attributes.
   * @return {any}                 - The edge.
   */
  addEdgeWithKey(edge, source, target, attributes) {
    return this._addEdge(
      'addEdgeWithKey',
      this.type === 'undirected',
      edge,
      source,
      target,
      attributes
    );
  }

  /**
   * Method used to add a directed edge to the graph using the given key.
   *
   * @param  {any}    edge         - The edge's key.
   * @param  {any}    source       - The source node.
   * @param  {any}    target       - The target node.
   * @param  {object} [attributes] - Optional attributes.
   * @return {any}                 - The edge.
   */
  addDirectedEdgeWithKey(edge, source, target, attributes) {
    return this._addEdge(
      'addDirectedEdgeWithKey',
      false,
      edge,
      source,
      target,
      attributes
    );
  }

  /**
   * Method used to add an undirected edge to the graph using the given key.
   *
   * @param  {any}    edge         - The edge's key.
   * @param  {any}    source       - The source node.
   * @param  {any}    target       - The target node.
   * @param  {object} [attributes] - Optional attributes.
   * @return {any}                 - The edge.
   */
  addUndirectedEdgeWithKey(edge, source, target, attributes) {
    return this._addEdge(
      'addUndirectedEdgeWithKey',
      true,
      edge,
      source,
      target,
      attributes
    );
  }

  /**
   * Method used to add an edge of the type of the graph or directed if the
   * graph is mixed. An id will automatically be created for it using the
   * 'edgeKeyGenerator' option.
   *
   * @param  {any}    source       - The source node.
   * @param  {any}    target       - The target node.
   * @param  {object} [attributes] - Optional attributes.
   * @return {any}                 - The edge.
   */
  addEdge(source, target, attributes) {
    const edge = this._options.edgeKeyGenerator(
      this.type === 'undirected',
      source,
      target,
      attributes
    );

    return this._addEdge(
      'addEdge',
      this.type === 'undirected',
      edge,
      source,
      target,
      attributes
    );
  }

  /**
   * Method used to add a directed edge to the graph. An id will automatically
   * be created for it using the 'edgeKeyGenerator' option.
   *
   * @param  {any}    source       - The source node.
   * @param  {any}    target       - The target node.
   * @param  {object} [attributes] - Optional attributes.
   * @return {any}                 - The edge.
   */
  addDirectedEdge(source, target, attributes) {

    // Generating an id
    const edge = this._options.edgeKeyGenerator(
      false,
      source,
      target,
      attributes
    );

    return this._addEdge(
      'addDirectedEdge',
      false,
      edge,
      source,
      target,
      attributes
    );
  }

  /**
   * Method used to add an undirected edge to the graph. An id will automatically
   * be created for it using the 'edgeKeyGenerator' option.
   *
   * @param  {any}    source       - The source node.
   * @param  {any}    target       - The target node.
   * @param  {object} [attributes] - Optional attributes.
   * @return {any}                 - The edge.
   */
  addUndirectedEdge(source, target, attributes) {

    // Generating an id
    const edge = this._options.edgeKeyGenerator(
      false,
      source,
      target,
      attributes
    );

    return this._addEdge(
      'addUndirectedEdge',
      true,
      edge,
      source,
      target,
      attributes
    );
  }

  /**
   * Method used to drop a single node & all its attached edges from the graph.
   *
   * @param  {any}    node - The node.
   * @return {Graph}
   *
   * @throws {Error} - Will throw if the node doesn't exist.
   */
  dropNode(node) {
    if (!this.hasNode(node))
      throw new NotFoundGraphError(`Graph.dropNode: could not find the "${node}" node in the graph.`);

    // Removing attached edges
    const edges = this.edges(node);

    // NOTE: we could go faster here
    for (let i = 0, l = edges.length; i < l; i++)
      this.dropEdge(edges[i]);

    // Dropping the node from the register
    if (this.map)
      this._nodes.delete(node);
    else
      delete this._nodes[node];

    // Decrementing order
    this._order--;
  }

  /**
   * Method used to drop a single edge from the graph.
   *
   * @param  {any}    edge - The edge.
   * @return {Graph}
   *
   * @throws {Error} - Will throw if the edge doesn't exist.
   */
  dropEdge(edge) {
    if (!this.hasEdge(edge))
      throw new NotFoundGraphError(`Graph.dropEdge: could not find the "${edge}" edge in the graph.`);

    const data = this.map ? this._edges.get(edge) : this._edges[edge];

    // Dropping the edge from the register
    if (this.map)
      this._edges.delete(edge);
    else
      delete this._edges[edge];

    // Decrementing size
    this._size--;

    // Updating related degrees
    const {source, target, undirected} = data;

    const sourceData = this.map ? this._nodes.get(source) : this._nodes[source],
          targetData = this.map ? this._nodes.get(target) : this._nodes[target];

    if (source === target) {
      sourceData.selfLoops--;
    }
    else {
      if (undirected) {
        sourceData.undirectedDegree--;
        targetData.undirectedDegree--;
      }
      else {
        sourceData.outDegree--;
        targetData.inDegree--;
      }
    }

    // Clearing index
    this._clearEdgeFromIndex('structure', edge, data);

    return this;
  }

  /**
   * Method used to drop a bunch of nodes or every node from the graph.
   *
   * @param  {bunch} nodes - Bunch of nodes.
   * @return {Graph}
   *
   * @throws {Error} - Will throw if an invalid bunch is provided.
   * @throws {Error} - Will throw if any of the nodes doesn't exist.
   */
  dropNodes(nodes) {
    if (!arguments.length)
      return this.clear();

    if (!isBunch(nodes))
      throw new InvalidArgumentsGraphError('Graph.dropNodes: invalid bunch.');

    overBunch(nodes, (error, node) => {
      this.dropNode(node);
    });

    return this;
  }

  /**
   * Method used to drop a bunch of edges or every edges from the graph.
   *
   * @param  {bunch} edges - Bunch of edges.
   * @return {Graph}
   *
   * @throws {Error} - Will throw if an invalid bunch is provided.
   * @throws {Error} - Will throw if any of the edges doesn't exist.
   */
  dropEdges(edges) {
    if (!arguments.length) {

      // Dropping every edge from the graph
      this._edges = this.map ? new Map() : {};
      this._size = 0;

      // Without edges, we've got no 'structure'
      this.clearIndex('structure');

      // TODO: if index precomputed, activate it here
      return this;
    }

    if (!isBunch(edges))
      throw new InvalidArgumentsGraphError('Graph.dropEdges: invalid bunch.');

    overBunch(edges, (error, edge) => {
      this.dropEdge(edge);
    });

    return this;
  }

  /**
   * Method used to remove every edge & every node from the graph.
   *
   * @return {Graph}
   */
  clear() {

    // Dropping edges
    this._edges = this.map ? new Map() : {};

    // Dropping nodes
    this._nodes = this.map ? new Map() : {};

    // Resetting counters
    this._order = 0;
    this._size = 0;

    for (const name in this._indices)
      this._indices[name].computed = false;

    // TODO: if index precomputed, activate it
  }

  /**---------------------------------------------------------------------------
   * Iteration-related methods
   **---------------------------------------------------------------------------
   */

  /**
   * Method returning the list of the graph's nodes.
   *
   * @return {array} - The nodes.
   */
  nodes() {

    if (this.map)
      return [...this._nodes.keys()];

    return Object.keys(this._nodes);
  }

  /**---------------------------------------------------------------------------
   * Import / Export
   **---------------------------------------------------------------------------
   */

  /**
   * Method exporting the target node.
   *
   * @param  {any}   node - Target node.
   * @return {array}      - The serialized node.
   *
   * @throws {Error} - Will throw if the node is not found.
   */
  exportNode(node) {
    if (!this.hasNode(node))
      throw new NotFoundGraphError(`Graph.exportNode: could not find the "${node}" node in the graph.`);

    const data = this.map ? this._nodes.get(node) : this._nodes[node];

    return serializeNode(node, data);
  }

  /**
   * Method exporting the target edge.
   *
   * @param  {any}   edge - Target edge.
   * @return {array}      - The serialized edge.
   *
   * @throws {Error} - Will throw if the edge is not found.
   */
  exportEdge(edge) {
    if (!this.hasEdge(edge))
      throw new NotFoundGraphError(`Graph.exportEdge: could not find the "${edge}" edge in the graph.`);

    const data = this.map ? this._edges.get(edge) : this._edges[edge];

    return serializeEdge(edge, data);
  }

  /**
   * Method exporting every nodes or the bunch ones.
   *
   * @param  {mixed}   [bunch] - Target nodes.
   * @return {array[]}         - The serialized nodes.
   *
   * @throws {Error} - Will throw if any of the nodes is not found.
   */
  exportNodes(bunch) {
    let nodes = [];

    if (!arguments.length) {

      // Exporting every node
      nodes = this.nodes();
    }
    else {

      // Exporting the bunch
      if (!isBunch(bunch))
        throw new InvalidArgumentsGraphError('Graph.exportNodes: invalid bunch.');

      overBunch(bunch, (error, node) => {
        if (!this.hasNode(node))
          throw new NotFoundGraphError(`Graph.exportNodes: could not find the "${node}" node from the bunch in the graph.`);
        nodes.push(node);
      });
    }

    const serializedNodes = new Array(nodes.length);

    for (let i = 0, l = nodes.length; i < l; i++)
      serializedNodes[i] = this.exportNode(nodes[i]);

    return serializedNodes;
  }

  /**
   * Internal method abstracting edges export.
   *
   * @param  {string}   name      - Child method name.
   * @param  {function} predicate - Predicate to filter the bunch's edges.
   * @param  {mixed}    [bunch]   - Target edges.
   * @return {array[]}            - The serialized edges.
   *
   * @throws {Error} - Will throw if any of the edges is not found.
   */
  _exportEdges(name, predicate, bunch) {
    let edges = [];

    if (!bunch) {

      // Exporting every edges of the given type
      if (name === 'exportEdges')
        edges = this.edges();
      else if (name === 'exportDirectedEdges')
        edges = this.directedEdges();
      else
        edges = this.undirectedEdges();
    }
    else {

      // Exporting the bunch
      if (!isBunch(bunch))
        throw new InvalidArgumentsGraphError(`Graph.${name}: invalid bunch.`);

      overBunch(bunch, (error, edge) => {
        if (!this.hasEdge(edge))
          throw new NotFoundGraphError(`Graph.${name}: could not find the "${edge}" edge from the bunch in the graph.`);

        if (!predicate || predicate(edge))
          edges.push(edge);
      });
    }

    const serializedEdges = new Array(edges.length);

    for (let i = 0, l = edges.length; i < l; i++)
      serializedEdges[i] = this.exportEdge(edges[i]);

    return serializedEdges;
  }

  /**
   * Method exporting every edges or the bunch ones.
   *
   * @param  {mixed}   [bunch] - Target edges.
   * @return {array[]}         - The serialized edges.
   *
   * @throws {Error} - Will throw if any of the edges is not found.
   */
  exportEdges(bunch) {
    return this._exportEdges(
      'exportEdges',
      null,
      bunch
    );
  }

  /**
   * Method exporting every directed edges or the bunch ones which are directed.
   *
   * @param  {mixed}   [bunch] - Target edges.
   * @return {array[]}         - The serialized edges.
   *
   * @throws {Error} - Will throw if any of the edges is not found.
   */
  exportDirectedEdges(bunch) {
    return this._exportEdges(
      'exportDirectedEdges',
      edge => this.directed(edge),
      bunch
    );
  }

  /**
   * Method exporting every unddirected edges or the bunch ones which are
   * undirected
   *
   * @param  {mixed}   [bunch] - Target edges.
   * @return {array[]}         - The serialized edges.
   *
   * @throws {Error} - Will throw if any of the edges is not found.
   */
  exportUndirectedEdges(bunch) {
    return this._exportEdges(
      'exportUndirectedEdges',
      edge => this.undirected(edge),
      bunch
    );
  }

  /**
   * Method used to export the whole graph.
   *
   * @return {object} - The serialized graph.
   */
  export() {
    return {
      nodes: this.exportNodes(),
      edges: this.exportEdges()
    };
  }

  /**
   * Method used to import a serialized node.
   *
   * @param  {object} data - The serialized node.
   * @return {Graph}       - Returns itself for chaining.
   */
  importNode(data) {

    // Validating
    const {valid, reason} = validateSerializedNode(data);

    if (!valid) {
      if (reason === 'not-object')
        throw new InvalidArgumentsGraphError('Graph.importNode: invalid serialized node. A serialized node should be a plain object with at least a "key" property.');
      if (reason === 'no-key')
        throw new InvalidArgumentsGraphError('Graph.importNode: no key provided.');
      if (reason === 'invalid-attributes')
        throw new InvalidArgumentsGraphError('Graph.importNode: invalid attributes. Attributes should be a plain object, null or omitted.');
    }

    // Adding the node
    const {key, attributes = {}} = data;

    this.addNode(key, attributes);

    return this;
  }

  /**
   * Method used to import a serialized edge.
   *
   * @param  {object} data - The serialized edge.
   * @return {Graph}       - Returns itself for chaining.
   */
  importEdge(data) {

    // Validating
    const {valid, reason} = validateSerializedEdge(data);

    if (!valid) {
      if (reason === 'not-object')
        throw new InvalidArgumentsGraphError('Graph.importEdge: invalid serialized edge. A serialized edge should be a plain object with at least a "source" & "target" property.');
      if (reason === 'no-source')
        throw new InvalidArgumentsGraphError('Graph.importEdge: missing souce.');
      if (reason === 'no-target')
        throw new InvalidArgumentsGraphError('Graph.importEdge: missing target');
      if (reason === 'invalid-attributes')
        throw new InvalidArgumentsGraphError('Graph.importEdge: invalid attributes. Attributes should be a plain object, null or omitted.');
      if (reason === 'invalid-undirected')
        throw new InvalidArgumentsGraphError('Graph.importEdge: invalid undirected. Undirected should be boolean or omitted.');
    }

    // Adding the edge
    const {
      source,
      target,
      attributes = {},
      undirected = false
    } = data;

    let method;

    if ('key' in data) {
      method = undirected ? this.addUndirectedEdgeWithKey : this.addEdgeWithKey;

      method.call(
        this,
        data.key,
        source,
        target,
        attributes
      );
    }
    else {
      method = undirected ? this.addUndirectedEdge : this.addDirectedEdge;

      method.call(
        this,
        source,
        target,
        attributes
      );
    }

    return this;
  }

  /**
   * Method used to import serialized nodes.
   *
   * @param  {array} nodes - The serialized nodes.
   * @return {Graph}       - Returns itself for chaining.
   */
  importNodes(nodes) {
    if (!Array.isArray(nodes))
      throw new InvalidArgumentsGraphError('Graph.importNodes: invalid argument. Expecting an array.');

    for (let i = 0, l = nodes.length; i < l; i++)
      this.importNode(nodes[i]);

    return this;
  }

  /**
   * Method used to import serialized edges.
   *
   * @param  {array} edges - The serialized edges.
   * @return {Graph}       - Returns itself for chaining.
   */
  importEdges(edges) {
    if (!Array.isArray(edges))
      throw new InvalidArgumentsGraphError('Graph.importEdges: invalid argument. Expecting an array.');

    for (let i = 0, l = edges.length; i < l; i++)
      this.importEdge(edges[i]);

    return this;
  }

  /**
   * Method used to import a serialized graph.
   *
   * @param  {object|Graph} data - The serialized graph.
   * @return {Graph}             - Returns itself for chaining.
   */
  import(data) {

    // Importing a Graph instance
    if (isGraph(data)) {

      this.import(data.export());
      return this;
    }

    // Importing a serialized graph
    if (!isPlainObject(data) || !data.nodes)
      throw new InvalidArgumentsGraphError('Graph.import: invalid argument. Expecting an object with at least a "nodes" property or, alternatively, a Graph instance.');

    this.importNodes(data.nodes);

    if (data.edges)
      this.importEdges(data.edges);

    return this;
  }

  /**
   * Method returning an empty copy of the graph, i.e. a graph without nodes
   * & edges but with the exact same options.
   *
   * @return {Graph} - The empty copy.
   */
  emptyCopy() {
    return new Graph(null, this._options);
  }

  /**
   * Method returning an exact copy of the graph.
   *
   * @return {Graph} - The copy.
   */
  copy() {
    return new Graph(this, this._options);
  }

  /**---------------------------------------------------------------------------
   * Indexes-related methods
   **---------------------------------------------------------------------------
   */

  /**
   * Method computing the desired index.
   *
   * @param  {string} name - Name of the index to compute.
   * @return {Graph}       - Returns itself for chaining.
   *
   * @throw  {Error} - Will throw if the index doesn't exist.
   */
  computeIndex(name) {

    if (!INDICES.has(name))
      throw new InvalidArgumentsGraphError(`Graph.computeIndex: unknown "${name}" index.`);

    if (name === 'structure') {
      const index = this._indices.structure;

      if (index.computed)
        return this;

      index.computed = true;

      if (this.map) {
        this._edges.forEach((data, edge) => this._updateIndex(name, edge, data));
      }
      else {
        for (const edge in this._edges)
          this._updateIndex(name, edge, this._edges[edge]);
      }
    }

    return this;
  }

  /**
   * Method updating the desired index.
   *
   * @param  {string} name      - Name of the index to compute.
   * @param  {mixed}  [...args] - Additional arguments.
   * @return {Graph}            - Returns itself for chaining.
   *
   * @throw  {Error} - Will throw if the index doesn't exist.
   */
  _updateIndex(name, ...args) {
    if (!INDICES.has(name))
      throw new InvalidArgumentsGraphError(`Graph._updateIndex: unknown "${name}" index.`);

    if (name === 'structure') {
      const index = this._indices.structure;

      if (!index.computed)
        return this;

      const [edge, data] = args;

      updateStructureIndex(this, edge, data);
    }

    return this;
  }

  /**
   * Method used to clear an edge from the desired index to clear memory.
   *
   * @param  {string} name - Name of the index to update.
   * @param  {any}    edge - Target edge.
   * @param  {object} data - Former attached data.
   * @return {Graph}       - Returns itself for chaining.
   *
   * @throw  {Error} - Will throw if the index doesn't exist.
   */
  _clearEdgeFromIndex(name, edge, data) {
    if (!INDICES.has(name))
      throw new InvalidArgumentsGraphError(`Graph._clearEdgeFromIndex: unknown "${name}" index.`);

    if (name === 'structure') {
      const index = this._indices.structure;

      if (!index.computed)
        return this;

      clearEdgeFromStructureIndex(this, edge, data);
    }

    return this;
  }

  /**
   * Method used to clear the desired index to clear memory.
   *
   * @param  {string} name - Name of the index to compute.
   * @return {Graph}       - Returns itself for chaining.
   *
   * @throw  {Error} - Will throw if the index doesn't exist.
   */
  clearIndex(name) {
    if (!INDICES.has(name))
      throw new InvalidArgumentsGraphError(`Graph.clearIndex: unknown "${name}" index.`);

    if (name === 'structure') {
      const index = this._indices.structure;

      if (!index.computed)
        return this;

      clearStructureIndex(this);
      index.computed = false;
    }

    return this;
  }

  /**---------------------------------------------------------------------------
   * Known methods
   **---------------------------------------------------------------------------
   */

  /**
   * Method used by JavaScript to perform JSON serialization.
   *
   * @return {object} - The serialized graph.
   */
  toJSON() {
    return this.export();
  }

  /**
   * Method used to perform string coercion and returning useful information
   * about the Graph instance.
   *
   * @return {string} - String representation of the graph.
   */
  toString() {
    const pluralOrder = this.order > 1 || this.order === 0,
          pluralSize = this.size > 1 || this.size === 0;

    return `Graph<${prettyPrint(this.order)} node${pluralOrder ? 's' : ''}, ${prettyPrint(this.size)} edge${pluralSize ? 's' : ''}>`;
  }

  /**
   * Method used internally by node's console to display a custom object.
   *
   * @return {object} - Formatted object representation of the graph.
   */
  inspect() {
    let nodes,
        edges;

    if (this.map) {
      nodes = new Map();
      this._nodes.forEach(function(value, key) {
        const attributes = value.attributes;

        nodes.set(key, Object.keys(attributes).length ? attributes : '<empty>');
      });

      edges = [];
      this._edges.forEach(function(value, key) {

        const formatted = [
          key,
          value.source,
          value.undirected ? '<->' : '->',
          value.target
        ];

        if (Object.keys(value.attributes).length)
          formatted.push(value.attributes);

        edges.push(formatted);
      });
    }
    else {
      nodes = {};
      edges = [];

      for (const k in this._nodes) {
        const attributes = this._nodes[k].attributes;
        nodes[k] = Object.keys(attributes).length ? attributes : '<empty>';
      }

      for (const k in this._edges) {
        const value = this._edges[k];

        const formatted = [
          k,
          value.source,
          value.undirected ? '<->' : '->',
          value.target
        ];

        if (Object.keys(value.attributes).length)
          formatted.push(value.attributes);

        edges.push(formatted);
      }
    }

    const dummy = {};

    for (const k in this) {
      if (this.hasOwnProperty(k) && !EMITTER_PROPS.has(k))
        dummy[k] = this[k];
    }

    dummy.nodes = nodes;
    dummy.edges = edges;

    privateProperty(dummy, 'constructor', this.constructor);

    return dummy;
  }

  /**
   * Method used to inspect the internal data structure holding nodes & edges.
   *
   * @return {object} - The internals to show.
   */
  internals() {
    return {
      nodes: this._nodes,
      edges: this._edges
    };
  }
}

/**
 * Attaching iteration methods to the prototype.
 *
 * Here, we create iteration methods for every kind of iteration by attaching
 * them to the Graph class prototype rather than writing a lot of custom methods
 * one by one.
 */

/**
 * Attributes-related.
 */
attachAttributesMethods(Graph);

/**
 * Edge iteration-related.
 */
attachEdgeIterationMethods(Graph);

/**
 * Neighbor iteration-related.
 */
attachNeighborIterationMethods(Graph);
