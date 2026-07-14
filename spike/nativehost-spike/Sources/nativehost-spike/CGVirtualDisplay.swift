//
//  CGVirtualDisplay.swift
//
//  *** PRIVATE, UNDOCUMENTED API — SPIKE ONLY, MUST NEVER SHIP AS-IS ***
//
//  `CGVirtualDisplay` / `CGVirtualDisplayDescriptor` / `CGVirtualDisplaySettings` /
//  `CGVirtualDisplayMode` are private Objective-C classes that live inside the
//  CoreGraphics framework. Apple ships no public header for them. The interface
//  below is reverse-engineered from public write-ups/class-dump output of
//  CoreGraphics.framework and is NOT guaranteed to be accurate or stable across
//  macOS releases (including point releases). It exists purely to let the
//  `virtualdisplay` probe in this throwaway spike attempt to answer Q1
//  ("does a headless virtual display keep producing live capture frames?").
//
//  Rather than statically re-declaring these as `@objc` Swift classes (which
//  would collide with the real runtime classes CoreGraphics registers under the
//  same name and crash at launch with a duplicate-class error), this file looks
//  the real classes up at runtime via `NSClassFromString`, allocates/initializes
//  them via `objc_msgSend`-style dispatch to their known selectors, and sets
//  properties via KVC — guarding every single step with a `responds(to:)` check
//  first. If a selector is missing, we print a precise diagnostic (which class,
//  which selector) and fail gracefully instead of crashing or silently no-oping.
//
//  KNOWN UNCERTAINTY (flagged for the human reviewing FINDINGS.md):
//    - The exact property names on CGVirtualDisplayDescriptor/Settings/Mode are
//      a best-effort match to the brief's spec; Cocoa KVC setter-selector
//      convention (`set<Key>:`) is assumed.
//    - The `terminationHandler` block's exact parameter signature is NOT
//      publicly documented anywhere we could verify; the guess below
//      (`(CGDirectDisplayID, Bool, CFDictionary?) -> Void`) may be wrong. If the
//      real class responds to `setTerminationHandler:` but the block signature
//      is wrong, this can crash when CoreGraphics later *invokes* the handler
//      (not at `virtualdisplay` startup) — a risk worth calling out to the human.
//    - If `class_getInstanceMethod` finds a selector but our guessed C argument
//      types don't match the real Objective-C type encoding, the
//      `unsafeBitCast`'d call can crash. We mitigate this by printing the
//      *actual* Objective-C type encoding string for every selector we invoke,
//      so the human can compare it against our assumption and fix this file.
//

import Foundation
import ObjectiveC
import CoreGraphics

// MARK: - Result type

struct VirtualDisplayHandle {
    /// Keep a strong reference alive for the lifetime of the probe — CGVirtualDisplay
    /// tears the phantom display down when this object is deallocated.
    let displayObject: AnyObject
    let descriptorObject: AnyObject
    let settingsObject: AnyObject
    let displayID: CGDirectDisplayID
    let widthPx: UInt32
    let heightPx: UInt32
}

// MARK: - Low-level ObjC runtime helpers

/// Prints the real Objective-C type encoding for a selector on a class, if it exists.
/// This is the single most useful diagnostic for fixing a wrong guessed signature.
private func logTypeEncoding(class cls: AnyClass, selector: Selector, isClassMethod: Bool) -> Method? {
    let method = isClassMethod ? class_getClassMethod(cls, selector) : class_getInstanceMethod(cls, selector)
    guard let method = method else {
        print("  [private-api] ERROR: \(NSStringFromClass(cls)) does not respond to \(isClassMethod ? "+" : "-")\(selector). Private interface shape has likely changed on this macOS version.")
        return nil
    }
    if let encoding = method_getTypeEncoding(method) {
        print("  [private-api] OK: \(NSStringFromClass(cls)) \(isClassMethod ? "+" : "-")\(selector) exists. Observed type encoding: \(String(cString: encoding))")
    }
    return method
}

private func objcClass(_ name: String) -> AnyClass? {
    guard let cls = NSClassFromString(name) else {
        print("  [private-api] ERROR: class '\(name)' not found via NSClassFromString. Either CoreGraphics did not export/load this private class on this OS build, or the class has been renamed. Treat CGVirtualDisplay as NOT VIABLE without further reverse engineering.")
        return nil
    }
    return cls
}

private func objcAlloc(_ cls: AnyClass) -> AnyObject? {
    let sel = NSSelectorFromString("alloc")
    guard logTypeEncoding(class: cls, selector: sel, isClassMethod: true) != nil else { return nil }
    typealias Fn = @convention(c) (AnyClass, Selector) -> Unmanaged<AnyObject>?
    let imp = method_getImplementation(class_getClassMethod(cls, sel)!)
    let fn = unsafeBitCast(imp, to: Fn.self)
    return fn(cls, sel)?.takeRetainedValue()
}

private func objcInitPlain(_ instance: AnyObject) -> AnyObject? {
    let sel = NSSelectorFromString("init")
    let cls: AnyClass = object_getClass(instance)!
    guard logTypeEncoding(class: cls, selector: sel, isClassMethod: false) != nil else { return nil }
    typealias Fn = @convention(c) (AnyObject, Selector) -> Unmanaged<AnyObject>?
    let imp = method_getImplementation(class_getInstanceMethod(cls, sel)!)
    let fn = unsafeBitCast(imp, to: Fn.self)
    return fn(instance, sel)?.takeRetainedValue()
}

private func objcInitWithObjectArg(_ instance: AnyObject, selectorName: String, arg: AnyObject) -> AnyObject? {
    let sel = NSSelectorFromString(selectorName)
    let cls: AnyClass = object_getClass(instance)!
    guard logTypeEncoding(class: cls, selector: sel, isClassMethod: false) != nil else { return nil }
    typealias Fn = @convention(c) (AnyObject, Selector, AnyObject) -> Unmanaged<AnyObject>?
    let imp = method_getImplementation(class_getInstanceMethod(cls, sel)!)
    let fn = unsafeBitCast(imp, to: Fn.self)
    return fn(instance, sel, arg)?.takeRetainedValue()
}

private func objcInitWithWidthHeightRefresh(_ instance: AnyObject, width: UInt32, height: UInt32, refreshRate: Double) -> AnyObject? {
    let sel = NSSelectorFromString("initWithWidth:height:refreshRate:")
    let cls: AnyClass = object_getClass(instance)!
    guard logTypeEncoding(class: cls, selector: sel, isClassMethod: false) != nil else { return nil }
    typealias Fn = @convention(c) (AnyObject, Selector, UInt32, UInt32, Double) -> Unmanaged<AnyObject>?
    let imp = method_getImplementation(class_getInstanceMethod(cls, sel)!)
    let fn = unsafeBitCast(imp, to: Fn.self)
    return fn(instance, sel, width, height, refreshRate)?.takeRetainedValue()
}

private func objcApply(_ instance: AnyObject, settings: AnyObject) -> Bool? {
    let sel = NSSelectorFromString("apply:")
    let cls: AnyClass = object_getClass(instance)!
    guard logTypeEncoding(class: cls, selector: sel, isClassMethod: false) != nil else { return nil }
    typealias Fn = @convention(c) (AnyObject, Selector, AnyObject) -> Bool
    let imp = method_getImplementation(class_getInstanceMethod(cls, sel)!)
    let fn = unsafeBitCast(imp, to: Fn.self)
    return fn(instance, sel, settings)
}

private func objcDisplayID(_ instance: AnyObject) -> CGDirectDisplayID? {
    let sel = NSSelectorFromString("displayID")
    let cls: AnyClass = object_getClass(instance)!
    guard logTypeEncoding(class: cls, selector: sel, isClassMethod: false) != nil else { return nil }
    typealias Fn = @convention(c) (AnyObject, Selector) -> CGDirectDisplayID
    let imp = method_getImplementation(class_getInstanceMethod(cls, sel)!)
    let fn = unsafeBitCast(imp, to: Fn.self)
    return fn(instance, sel)
}

/// Cocoa KVC setter-selector convention: `set` + first letter uppercased + rest + `:`.
private func setterSelectorName(for key: String) -> String {
    guard let first = key.first else { return "set:" }
    return "set" + first.uppercased() + key.dropFirst() + ":"
}

@discardableResult
private func setPrivateProperty(_ object: NSObject, key: String, value: Any?) -> Bool {
    let selName = setterSelectorName(for: key)
    let sel = NSSelectorFromString(selName)
    guard object.responds(to: sel) else {
        print("  [private-api] WARNING: \(NSStringFromClass(type(of: object))) does not respond to '\(selName)' — property '\(key)' may have been renamed/removed on this macOS version. Skipping.")
        return false
    }
    object.setValue(value, forKey: key)
    return true
}

// MARK: - High-level construction

/// Best-effort construction of a headless CGVirtualDisplay. Returns nil (with rich
/// diagnostics already printed) on any failure — never crashes on a missing selector.
func createReverseEngineeredVirtualDisplay(
    name: String,
    widthPx: UInt32,
    heightPx: UInt32,
    widthMM: UInt32,
    heightMM: UInt32
) -> VirtualDisplayHandle? {

    print("[virtualdisplay] Step 1/5: locating private classes...")
    guard let descriptorClass = objcClass("CGVirtualDisplayDescriptor"),
          let settingsClass = objcClass("CGVirtualDisplaySettings"),
          let modeClass = objcClass("CGVirtualDisplayMode"),
          let displayClass = objcClass("CGVirtualDisplay")
    else {
        return nil
    }

    print("[virtualdisplay] Step 2/5: constructing CGVirtualDisplayDescriptor...")
    guard let descriptorAlloc = objcAlloc(descriptorClass),
          let descriptor = objcInitPlain(descriptorAlloc) as? NSObject
    else {
        print("  [private-api] ERROR: failed to alloc/init CGVirtualDisplayDescriptor.")
        return nil
    }

    setPrivateProperty(descriptor, key: "name", value: name)
    setPrivateProperty(descriptor, key: "maxPixelsWide", value: NSNumber(value: widthPx))
    setPrivateProperty(descriptor, key: "maxPixelsHigh", value: NSNumber(value: heightPx))
    setPrivateProperty(descriptor, key: "sizeInMillimeters", value: NSValue(size: CGSize(width: CGFloat(widthMM), height: CGFloat(heightMM))))
    setPrivateProperty(descriptor, key: "productID", value: NSNumber(value: UInt32(0x1234)))
    setPrivateProperty(descriptor, key: "vendorID", value: NSNumber(value: UInt32(0x5678)))
    setPrivateProperty(descriptor, key: "serialNum", value: NSNumber(value: UInt32(0x0001)))
    setPrivateProperty(descriptor, key: "queue", value: DispatchQueue(label: "com.cate.spike.virtualdisplay"))

    // Best-effort; signature is unverified — see file header. Non-fatal if it doesn't stick.
    let terminationHandler: @convention(block) (CGDirectDisplayID, Bool, CFDictionary?) -> Void = { displayID, flag, dict in
        print("[virtualdisplay] terminationHandler fired: displayID=\(displayID) flag=\(flag) dict=\(String(describing: dict))")
    }
    setPrivateProperty(descriptor, key: "terminationHandler", value: terminationHandler)

    print("[virtualdisplay] Step 3/5: constructing CGVirtualDisplayMode + CGVirtualDisplaySettings...")
    guard let modeAlloc = objcAlloc(modeClass),
          let mode = objcInitWithWidthHeightRefresh(modeAlloc, width: widthPx, height: heightPx, refreshRate: 60.0)
    else {
        print("  [private-api] ERROR: failed to alloc/init CGVirtualDisplayMode via initWithWidth:height:refreshRate:.")
        return nil
    }

    guard let settingsAlloc = objcAlloc(settingsClass),
          let settings = objcInitPlain(settingsAlloc) as? NSObject
    else {
        print("  [private-api] ERROR: failed to alloc/init CGVirtualDisplaySettings.")
        return nil
    }
    setPrivateProperty(settings, key: "hiDPI", value: NSNumber(value: UInt32(0)))
    setPrivateProperty(settings, key: "modes", value: [mode])

    print("[virtualdisplay] Step 4/5: constructing CGVirtualDisplay via initWithDescriptor:...")
    guard let displayAlloc = objcAlloc(displayClass),
          let display = objcInitWithObjectArg(displayAlloc, selectorName: "initWithDescriptor:", arg: descriptor)
    else {
        print("  [private-api] ERROR: failed to alloc/init CGVirtualDisplay via initWithDescriptor:.")
        return nil
    }

    print("[virtualdisplay] Step 5/5: applying settings + reading displayID...")
    guard let applied = objcApply(display, settings: settings), applied else {
        print("  [private-api] ERROR: CGVirtualDisplay.apply(_:) returned false or the selector could not be invoked.")
        return nil
    }

    guard let displayID = objcDisplayID(display) else {
        print("  [private-api] ERROR: could not read CGVirtualDisplay.displayID.")
        return nil
    }

    return VirtualDisplayHandle(
        displayObject: display,
        descriptorObject: descriptor,
        settingsObject: settings,
        displayID: displayID,
        widthPx: widthPx,
        heightPx: heightPx
    )
}
