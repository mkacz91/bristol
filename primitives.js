import { Geometry, signnz, sq, vec2 } from "/math.js";
import { Broadcast, checkArgument, checkExpectation, checkNamedArgument, checkState, UnimplementedError } from "/utils.js";

export class Primitive {
  constructor(parents) {
    this.isSelectable = true;
    this.parents = parents;
    this.children = [];
    this.level = 0;
    for (const parent of parents) {
      console.assert(!parent.isDisposed);
      parent.children.push(this);
      this.level = Math.max(this.level, parent.level + 1);
    }
  }

  dispose() {
    checkState(!this.isDisposed, "Already disposed.");
    checkState(this.children.length == 0, "Dispose all descendants first.");
    this.beginChanges();
    for (const parent of this.parents) {
      parent.children.remove(this)
    }
    this.isDisposed = true;
    this._afterDisposalCallback(this);
  }

  get isInvalid() { return this._invalid; }

  set isInvalid(value) { this.setFlag('_invalid', value); }

  beginChanges() {
    this._beforeChangeCallback(this);
  }

  setFlag(name, value) {
    if (value) {
      this[name] = true;
    } else {
      delete this[name];
    }
  }

  dependsOn(other) {
    const descendants = new Set();
    descendants.add(other);
    for (const descendant of descendants) {
      if (descendant === this) {
        return true;
      } else if (descendant.level < this.level) {
        descendants.addAll(descendant.children);
      }
    }
    return false;
  }

  isIndependentOf(other) {
    return !this.dependsOn(other);
  }

  applyConstraints() { throw new UnimplementedError(); }

  closestPoint(_position) { throw new UnimplementedError(); }

  distSq(_position) { throw new UnimplementedError(); }

  tryDrag(_grabPosition) { throw new UnimplementedError(); }
}

export class Primitives {
  constructor () {
    this._primitives = new Map();
    this._nextPrimitiveId = 1;
    this._freePrimitiveIds = [];
    this._changedPrimitives = [];
    this._invalidatedPrimitives = [];
    this._intersectionPoints = new Map();
    this._beforeChangeCallback =
      primitive => this._beforePrimitiveChange(primitive);
    this._afterDisposalCallback =
      primitive => this._afterPrimitiveDisposal(primitive);
    this.beforeChange = new Broadcast();
    this.afterCreation = new Broadcast();
  }

  [Symbol.iterator]() {
    return this._primitives.values();
  }

  get(id) {
    return this._primitives.get(id);
  }

  createPoint(position) {
    return this._initializePrimitive(new FreePointPrimitive(position));
  }

  /// Returns an [IntersectionPointPrimitive] based on the two given parent
  /// primitives, or undefined if the primitives have no intersection.
  ///
  /// When there is already a matching existing point on record, it is returned
  /// and no new point is instantiated.
  ///
  /// The result is an object with the following properties:
  ///
  ///   * point: [IntersectionPointPrimitive] ,
  ///   * isExisting: boolean indicating whether the point is an existing one
  ///     or newly created.
  ///
  /// In case the primitives have more than one intersection, one is picked
  /// which is closer to the given reference [approximatePosition]. This rule is
  /// also preserved when picking an existing point.
  ///
  /// It is possible that an existing intersection point is on record, even if
  /// the parents have no intersection. It must have been created at a time when
  /// the parents were intersecting, but now is marked as invalid. It is
  /// debatable what to do in such situation, but the current implementation
  /// returns `undefined`.
  tryGetOrCreateIntersectionPoint(primitive0, primitive1, kwargs) {
    checkState(this._invalidatedPrimitives.length == 0);
    const approximatePosition = checkNamedArgument(
      kwargs, 'approximatePosition');
    const hints = kwargs.hints;
    const invalid = kwargs.invalid ?? false;

    const intersection = IntersectionPointPrimitive.intersection(
      primitive0, primitive1, {
      approximatePosition: approximatePosition,
      hints: hints,
    });
    const position = intersection.position;

    checkArgument(
      !(invalid && position), 'invalid', "Expected invalid intersection");
    if (!invalid && !position) {
      return undefined;
    }

    const id = Primitives._primitivePairId(primitive0, primitive1);
    const existing = this._intersectionPoints.getOrCompute(id, () => []);

    if (position) {
      const matching = existing.find(point => point.position.equals(position));
      if (matching) {
        return {
          point: matching,
          isExisting: true,
        };
      }
    } else {
      // We only expect invalid points during deserialization in which case
      // there should be hints and no conflicts. General solution, if ever
      // needed, left for future consideration.
      if (!hints) {
        throw new UnimplementedError("Missing hints.");
      }
      if (existing
          .some(point => point.hints
            .some(hint0 => hints
              .some(hint1 =>
                hint0[0] == hint1[0] &&
                hint0[1] == hint1[1])))) {
        throw new UnimplementedError("Conflicting invalid intersection points.");
      }
    }

    const point = this._initializePrimitive(
      new IntersectionPointPrimitive(
        primitive0, primitive1, {
        approximatePosition: approximatePosition,
        hints: hints,
      }));
    existing.push(point);
    return {
      point: point,
      isExisting: false,
    }
  }

  createLine(point0, point1) {
    return this._initializePrimitive(new TwoPointLinePrimitive(point0, point1));
  }

  createCircle(point0, point1) {
    return this._initializePrimitive(new CirclePrimitive(point0, point1));
  }

  edit(changes) {
    // We're not checking if each operation is wrapped in an `edit` block, but
    // if there is a violation, it will be eventually detected here.
    console.assert(this._changedPrimitives.length == 0);

    try {
      changes();
    } finally {
      this._afterPrimitiveChanges();
    }
  }

  _initializePrimitive(primitive) {
    // Main purpose of the `_freePrimitiveIds` stack is to ensure deterministig
    // ID assignment during undo-redo operations.
    primitive.id = this._freePrimitiveIds.pop() ?? this._nextPrimitiveId++;
    primitive._beforeChangeCallback = this._beforeChangeCallback;
    primitive._afterDisposalCallback = this._afterDisposalCallback
    this._primitives.set(primitive.id, primitive);
    primitive.applyConstraints();
    this.afterCreation.publish(primitive);
    return primitive;
  }

  _beforePrimitiveChange(primitive) {
    checkState(!primitive.isDisposed, "Changing disposed primitive.");
    if (this._changedPrimitives.includes(primitive)) {
      return;
    }
    if (this._invalidatedPrimitives.includes(primitive)) {
      throw new Error("Changing invalidated primitive.");
    }
    const newlyInvalidatedStart = this._invalidatedPrimitives.length;
    let i = newlyInvalidatedStart;
    this._invalidatedPrimitives.push(primitive);
    while (i < this._invalidatedPrimitives.length) {
      const invalidated = this._invalidatedPrimitives[i++];
      if (this._changedPrimitives.includes(invalidated)) {
        throw new Error("Invalidating changed primitive.");
      }
      for (const child of invalidated.children) {
        if (!this._invalidatedPrimitives.includes(child)) {
          this._invalidatedPrimitives.push(child);
        }
      }
    }
    this._changedPrimitives.push(primitive);
    const newlyInvalidatedEnd = this._invalidatedPrimitives.length;
    for (i = newlyInvalidatedStart; i < newlyInvalidatedEnd; ++i) {
      this.beforeChange.publish(this._invalidatedPrimitives[i]);
    }
  }

  _afterPrimitiveChanges() {
    Primitives.sortByLevelAscending(this._invalidatedPrimitives);
    for (const primitive of this._invalidatedPrimitives) {
      if (!primitive.isDisposed) {
        primitive.applyConstraints();
      }
    }
    this._invalidatedPrimitives.length = 0;
    this._changedPrimitives.length = 0;
  }

  _afterPrimitiveDisposal(primitive) {
    this._primitives.delete(primitive.id);
    this._freePrimitiveIds.push(primitive.id);

    if (primitive instanceof IntersectionPointPrimitive) {
      const pairId = Primitives._primitivePairId(
        primitive.curve0, primitive.curve1);
      const points = this._intersectionPoints.get(pairId);
      if (points) {
        points.remove(primitive);
        if (points.length == 0) {
          this._intersectionPoints.delete(pairId);
        }
      }
    }
  }

  static sortByLevelAscending(primitives) {
    return primitives.sort((a, b) => a.level - b.level);
  }

  static sortByLevelDescending(primitives) {
    return primitives.sort((a, b) => b.level - a.level);
  }

  static dispose(primitives) {
    for (const primitive of Primitives.sortByLevelDescending([...primitives])) {
      primitive.dispose();
    }
  }

  static intersections(primitive0, primitive1) {
    if (primitive0 instanceof LinePrimitive) {
      return Primitives._lineIntersections(primitive0, primitive1);
    } else if (primitive0 instanceof CirclePrimitive) {
      return Primitives._circleIntersections(primitive0, primitive1);
    } else {
      return [];
    }
  }

  static _lineIntersections(line, primitive) {
    if (primitive instanceof LinePrimitive) {
      return Primitives._lineLineIntersections(line, primitive);
    } else if (primitive instanceof CirclePrimitive) {
      return Primitives._lineCircleIntersections(line, primitive);
    } else {
      return [];
    }
  }

  static _circleIntersections(circle, primitive) {
    if (primitive instanceof LinePrimitive) {
      return Primitives._lineCircleIntersections(primitive, circle);
    } else if (primitive instanceof CirclePrimitive) {
      return Primitives._circleCircleIntersections(circle, primitive);
    } else {
      return [];
    }
  }

  static _lineLineIntersections(line0, line1) {
    return Geometry.lineLineIntersections(
      line0.origin, line0.direction,
      line1.origin, line1.direction,
    );
  }

  static _lineCircleIntersections(line, circle) {
    return Geometry.lineCircleIntersections(
      line.origin, line.direction,
      circle.center, circle.radius,
    );
  }

  static _circleCircleIntersections(circle0, circle1) {
    return Geometry.circleCircleIntersections(
      circle0.center, circle0.radius,
      circle1.center, circle1.radius,
    );
  }

  static _primitivePairId(primitive0, primitive1) {
    const id0 = primitive0.id, id1 = primitive1.id;
    return id0 < id1
      ? (id0 << 16) | id1
      : (id1 << 16) | id0;
  }
}

export class PrimitiveDragger {
  constructor(primitive, grabPosition) {
    this.primitive = primitive;
    this.grabPosition = grabPosition.clone();
  }

  get canDrag() { return true; }

  get offenses() { return []; }

  dragTo(_position) { throw new UnimplementedError(); }
}

class PrimitiveNotDragger extends PrimitiveDragger {
  constructor(primitive, grabPosition, offenses) {
    super(primitive, primitive.closestPoint(grabPosition));
    this._offenses = offenses;
    this.position = grabPosition.clone();
  }

  get canDrag() { return false; }

  get offenses() { return this._offenses; }

  dragTo(position) {
    this.position.copy(position);
  } 
}

class CompoundPrimitiveDragger extends PrimitiveDragger {
  constructor(primitive, grabPosition, draggers) {
    super(primitive, grabPosition);
    this.draggers = draggers;
  }

  dragTo(position) {
    for (const dragger of this.draggers) {
      dragger.dragTo(position);
    }
  }
}

export class CurvePrimitive extends Primitive {
  constructor(parents) {
    super(parents);
  }

  tangentAt(_position) { throw new UnimplementedError() }
}

export class PointPrimitive extends Primitive {
  constructor(position, parents) {
    super(parents);
    this.position = position.clone();
  }

  distSq(P) {
    return vec2.distSq(this.position, P);
  }

  closestPoint(_) {
    return this.position;
  }

  tryMoveTo(position) {
    const dragger = this.tryDrag(this.position);
    if (dragger.canDrag) {
      dragger.dragTo(position);
      return true;
    } else {
      return false;
    }
  }

  moveTo(position) {
    checkState(this.tryMoveTo(position), "Cannot be moved.");
  }
}

class FreePointPrimitiveDragger extends PrimitiveDragger {
  constructor(point, grabPosition) {
    super(point, grabPosition);
    this.point = point;
    this.offset = vec2.span(grabPosition, point.position);
  }

  dragTo(position) {
    this.point.beginChanges();
    this.point.position.copy(position).add(this.offset);
  }
}

export class FreePointPrimitive extends PointPrimitive {
  constructor (position) {
    super(position, []);
  }

  applyConstraints() {
    // Do nothing.
  }

  tryDrag(grabPosition) {
    return new FreePointPrimitiveDragger(this, grabPosition);
  }
}

export class IntersectionPointPrimitive extends PointPrimitive {
  constructor(curve0, curve1, kwargs) {
    const approximatePosition = checkNamedArgument(
      kwargs, 'approximatePosition');
    const hints = kwargs.hints ?? [];

    super(approximatePosition, [curve0, curve1]);

    // For curves with multiple intersections, we remeber the index of the
    // chosen one for temporal consistency. The number of intersection may vary,
    // so instead of a single index, we store a map #intersections -> index.
    // When a previously unseen #intersections is witnessed, the choice is made
    // based on Euclidean distance wrt. previous position. After that, the index
    // is used irrespective of the Euclidean distance.
    this.hints = hints;
  }

  get curve0() { return this.parents[0]; }
  
  get curve1() { return this.parents[1]; }

  applyConstraints() {
    this.reset({ approximatePosition: this.position });
  }

  reset(kwargs) {
    const approximatePosition = checkNamedArgument(
      kwargs, 'approximatePosition');
    const hints = kwargs.hints ?? this.hints;
    const invalid = kwargs.invalid;

    const intersection = IntersectionPointPrimitive.intersection(
      this.curve0, this.curve1, {
      approximatePosition: approximatePosition,
      hints: hints,
    });
    if (intersection.position) {
      checkExpectation(invalid != true, "Expected invalid intersection.");
      this.position.copy(intersection.position);
      if (!intersection.isHint && intersection.all.length > 1) {
        hints.push([intersection.all.length, intersection.index]);
      }
      this.isInvalid = false;
    } else {
      checkExpectation(invalid != false, "Expected valid intersection");
      this.isInvalid = true;
    }
    this.hints = hints;
  }

  tryDrag(grabPosition) {
    return new PrimitiveNotDragger(this, grabPosition, [this]);
  }

  static intersection(primitive0, primitive1, kwargs) {
    const approximatePosition = checkNamedArgument(
      kwargs, 'approximatePosition');
    const hints = kwargs.hints;

    const intersections = Primitives.intersections(primitive0, primitive1)
    const hint = hints?.find(hint => hint[0] == intersections.length);
    const index = hint
      ? hint[1]
      : intersections.indexOfMinBy(position =>
          vec2.distSq(position, approximatePosition));

    return {
      position: intersections[index],
      all: intersections,
      index: index,
      isHint: !!hint,
    };
  }
}

class PivotPointPrimitiveDragger extends PrimitiveDragger {
  constructor (subject, grabPosition, pivot) {
    super(subject, grabPosition);
    this.pivot = pivot;
    this.subject = subject;
    this.distance = vec2.dist(pivot.position, subject.position);
  }

  dragTo(position) {
    this.subject.beginChanges();
    const u = vec2.span(this.pivot.position, position);
    const uLength = u.length();
    if (1000 * uLength < this.distance) {
      return;
    }
    const s = signnz(vec2.dot(
      u, vec2.span(this.pivot.position, this.subject.position)));
    this.subject.position
      .copy(this.pivot.position).addScaled(s * this.distance / uLength, u);
  }
}

const _TwoPointPrimitiveMixin = {
  tryDrag(grabPosition) {
    const point0 = this.parents[0], point1 = this.parents[1];
    const dragger0 = point0.tryDrag(grabPosition);
    const dragger1 = point1.tryDrag(grabPosition);
    if (dragger0.canDrag && dragger1.canDrag) {
      return new CompoundPrimitiveDragger(
        this, grabPosition, [dragger0, dragger1]);
    } else if (dragger0.canDrag) {
      if (point1.dependsOn(point0)) {
        return new PrimitiveNotDragger(
          this, grabPosition, [point1, [point0, point1]]);
      } else {
        return this._tryDrag0Fixed1(grabPosition);
      }
    } else if (dragger1.canDrag) {
      if (point0.dependsOn(point1)) {
        return new PrimitiveNotDragger(
          this, grabPosition, [point0, [point1, point0]]);
      } else {
        return this._tryDrag1Fixed0(grabPosition);
      }
    } else {
      return new PrimitiveNotDragger(this, grabPosition, [point0, point1]);
    }
  },
}

export class LinePrimitive extends CurvePrimitive {
  constructor (origin, direction, parents) {
    super(parents);
    this.origin = origin;
    this.direction = direction;
  }

  distSq(P) {
    const u = vec2.span(this.origin, P);
    return sq(vec2.per(this.direction, u)) / this.direction.lenSq();
  }

  eval(t) {
    return this.origin.clone().addScaled(t, this.direction);
  }

  tangentAt(_position) {
    return this.direction.clone();
  }
}

export class TwoPointLinePrimitive extends LinePrimitive {
  static install() {
    Object.assign(TwoPointLinePrimitive.prototype, _TwoPointPrimitiveMixin);
  }

  constructor(point0, point1) {
    super(new vec2(0, 0), new vec2(1, 0), [point0, point1]);
    this.applyConstraints();
  }

  get point0() { return this.parents[0]; }

  get point1() { return this.parents[1]; }

  applyConstraints() {
    this.origin.copy(this.point0.position);
    this.direction.span(this.origin, this.point1.position);
  }

  closestPoint(position) {
    return Geometry.lineClosestPoint(this.origin, this.direction, position);
  }

  _tryDrag0Fixed1(grabPosition) {
    return new PivotPointPrimitiveDragger(
      this.point0, grabPosition, this.point1);
  }

  _tryDrag1Fixed0(grabPosition) {
    return new PivotPointPrimitiveDragger(
      this.point1, grabPosition, this.point0);
  }
}

export class CirclePrimitive extends CurvePrimitive {
  static install() {
    Object.assign(CirclePrimitive.prototype, _TwoPointPrimitiveMixin);
  }

  constructor(centerPoint, edgePoint) {
    super([centerPoint, edgePoint]);
    this.center = new vec2(0, 0);
    this.applyConstraints();
  }

  get centerPoint() { return this.parents[0]; }

  get edgePoint() { return this.parents[1]; }

  distSq(position) {
    const d = vec2.dist(this.center, position);
    return sq(d - this.radius);
  }

  applyConstraints() {
    this.center.copy(this.centerPoint.position);
    this.radius = vec2.dist(this.center, this.edgePoint.position);
  }

  closestPoint(position) {
    return Geometry.circleClosestPoint(this.center, this.radius, position);
  }

  _tryDrag0Fixed1(_grabPosition) {
    return new FixedEdgeCirclePrimitiveDragger(
      this.centerPoint, this.edgePoint, grabPosition);
  }

  _tryDrag1Fixed0(_grabPosition) {
    return new FixedCernterCirclePrimitiveDragger(
      this.centerPoint, this.edgePoint);
  }
}

class FixedCernterCirclePrimitiveDragger extends PrimitiveDragger {
  constructor(centerPoint, edgePoint) {
    super();
    this.centerPoint = centerPoint;
    this.edgePoint = edgePoint;
    this.rayDirection =
      vec2.span(centerPoint.position, edgePoint.position).normalize();
  }

  dragTo(position) {
    this.edgePoint.beginChanges();
    const radius = vec2.dist(this.centerPoint.position, position);
    this.edgePoint.position
      .copy(this.centerPoint.position)
      .addScaled(radius, this.rayDirection);
  }
}

class FixedEdgeCirclePrimitiveDragger extends PrimitiveDragger {
  constructor(centerPoint, edgePoint, grabPosition) {
    super(centerPoint, grabPosition);
    this.centerPoint = centerPoint;
    this.edgePoint = edgePoint;

    const C = centerPoint.position, E = edgePoint.position, G = grabPosition;
    const EC = vec2.span(E, C);
    const EG = vec2.span(E, G);
    const M = vec2.mid(E, G);
    const MC = vec2.span(M, C);
    this.deviation =
      signnz(vec2.per(EC, EG)) *
      Math.sqrt(MC.lenSq() / EG.lenSq());
  }

  dragTo(position) {
    this.centerPoint.beginChanges();
    const E = this.edgePoint.position, P = position;
    this.centerPoint.position
      .mid(E, P)
      .addScaled(this.deviation, vec2.span(E, P).rot90R());
  }
}

export function installPrimitives() {
  TwoPointLinePrimitive.install();
  CirclePrimitive.install();
}