/**
 * Deliberately heavy type showcase used to validate TypeLoad.
 * Every construct here is legal TypeScript that stresses the checker.
 */

// 1. Large literal union — classic instantiation pressure.
export type Digit =
  | "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
export type TwoDigitNumber = `${Digit}${Digit}`;

// 2. Deep conditional chain over tuple lengths.
type Length<tup extends unknown[]> = tup["length"];
type DropFirst<tup extends unknown[]> = tup extends [unknown, ...infer rest]
  ? rest
  : [];
export type Depth10 = Length<DropFirst<DropFirst<DropFirst<DropFirst<[
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10
]>>>>>;

// 3. Recursive mapped/flattening type.
type FlattenDeep<t> = t extends readonly (infer inner)[]
  ? FlattenDeep<inner>
  : t;
export type FlatNest = FlattenDeep<[[[[[[[[[[42]]]]]]]]]]>;

// 4. Wide intersection of record types.
type Piece1 = { a: string; b: number; c: boolean };
type Piece2 = { d: string; e: number; f: boolean };
type Piece3 = { g: string; h: number; i: boolean };
type Piece4 = { j: string; k: number; l: boolean };
export type AllPieces = Piece1 & Piece2 & Piece3 & Piece4;

// 5. Expensive function signature (big intersection parameters).
export function combineAll(a: Piece1 & Piece2, b: Piece3 & Piece4): AllPieces {
  return { ...a, ...b };
}

// 6. Enum
export enum TransportMode {
  Walk = 0,
  Bike = 1,
  Car = 2,
  Train = 3,
}

// 7. Interface with many members.
export interface BigInterface {
  m1: TwoDigitNumber;
  m2: Depth10;
  m3: FlatNest;
  m4: AllPieces;
  m5: (x: Digit) => TwoDigitNumber;
  m6: Map<string, AllPieces[]>;
  m7: Set<Depth10>;
  m8: Promise<FlatNest | AllPieces>;
}

// 8. Variable with explicit type.
export const sample: BigInterface = {
  m1: "42",
  m2: 8,
  m3: 42,
  m4: { a: "x", b: 1, c: true, d: "x", e: 1, f: true, g: "x", h: 1, i: true, j: "x", k: 1, l: true },
  m5: (x) => `${x}${x}` as TwoDigitNumber,
  m6: new Map(),
  m7: new Set(),
  m8: Promise.resolve(42 as FlatNest),
};

// 9. Class with typed members.
export class Calculator {
  readonly id: TwoDigitNumber = "00";
  private history: BigInterface[] = [];
  add(entry: BigInterface): number {
    this.history.push(entry);
    return this.history.length;
  }
}
