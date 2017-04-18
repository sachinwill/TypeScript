class A { a: string; }
class B { b: number; }
class C { b: Object; }
class D { a: Date; }
class ClassWithProp { prop: A | B }
class NestedClassWithProp { outer: ClassWithProp }

function namedClasses(x: A | B) {
    if ("a" in x) {
        x.a = "1";
    } else {
        x.b = 1;
    }
}

function multipleClasses(x: A | B | C | D) {
    if ("a" in x) {
        let y: string | Date = x.a;
    } else {
        let z: number | Object = x.b;
    }
}

function anonymousClasses(x: { a: string; } | { b: number; }) {
    if ("a" in x) {
        let y: string = x.a;
    } else {
        let z: number = x.b;
    }
}
function inParenthesizedExpression(x: A | B) {
    if ("a" in (x)) {
        let y: string = x.a;
    } else {
        let z: number = x.b;
    }
}


function inProperty(x: ClassWithProp) {
    if ("a" in x.prop) {
        let y: string = x.prop.a;
    } else {
        let z: number = x.prop.b;
    }
}


function innestedProperty(x: NestedClassWithProp) {
    if ("a" in x.outer.prop) {
        let y: string = x.outer.prop.a;
    } else {
        let z: number = x.outer.prop.b;
    }
}

class InMemberOfClass {
    protected prop: A | B;
    inThis() {
        if ('a' in this.prop) {
            let y: string = this.prop.a;
        } else {
            let z: number = this.prop.b;
        }
    }
}

//added for completeness
class SelfAssert {
    a: string;
    inThis() {
        if ('a' in this) {
            let y: string = this.a;
        } else {
        }
    }
}