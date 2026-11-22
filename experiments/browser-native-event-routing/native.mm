#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <node_api.h>
#include <cstring>
#include <initializer_list>
#include <utility>

static napi_value getHit(napi_env env, napi_callback_info info) {
  size_t count = 4;
  napi_value args[4];
  void *bytes = nullptr;
  size_t size = 0;
  double x, y;
  int32_t below;
  if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok ||
      count != 4 || napi_get_buffer_info(env, args[0], &bytes, &size) != napi_ok ||
      size != sizeof(void *) ||
      napi_get_value_double(env, args[1], &x) != napi_ok ||
      napi_get_value_double(env, args[2], &y) != napi_ok ||
      napi_get_value_int32(env, args[3], &below) != napi_ok) {
    napi_throw_type_error(env, nullptr, "Expected native view, x, y and below window number");
    return nullptr;
  }
  void *address = nullptr;
  std::memcpy(&address, bytes, size);
  NSWindow *window = ((__bridge NSView *)address).window;
  if (!window) {
    napi_throw_error(env, nullptr, "View is not attached to a window");
    return nullptr;
  }
  NSRect content = window.contentView.frame;
  NSPoint point = [window convertPointToScreen:NSMakePoint(NSMinX(content) + x, NSMaxY(content) - y)];
  napi_value result, self, hit;
  napi_create_object(env, &result);
  napi_create_int32(env, (int32_t)window.windowNumber, &self);
  napi_create_int32(env, (int32_t)[NSWindow windowNumberAtPoint:point belowWindowWithWindowNumber:below], &hit);
  napi_set_named_property(env, result, "self", self);
  napi_set_named_property(env, result, "hit", hit);
  return result;
}

static napi_value queueClick(napi_env env, napi_callback_info info) {
  napi_value args[3], result;
  size_t count = 3, size = 0;
  void *bytes = nullptr;
  double x, y;
  if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok ||
      count != 3 || napi_get_buffer_info(env, args[0], &bytes, &size) != napi_ok ||
      size != sizeof(void *) || napi_get_value_double(env, args[1], &x) != napi_ok ||
      napi_get_value_double(env, args[2], &y) != napi_ok) {
    napi_throw_type_error(env, nullptr, "Expected a test window and local coordinates");
    return nullptr;
  }
  void *address = nullptr;
  std::memcpy(&address, bytes, size);
  NSWindow *window = ((__bridge NSView *)address).window;
  if (!window || !window.isVisible) {
    napi_throw_error(env, nullptr, "Test window is hidden");
    return nullptr;
  }
  NSRect content = window.contentView.frame;
  NSPoint point = NSMakePoint(NSMinX(content) + x, NSMaxY(content) - y);
  for (NSEventType type : {NSEventTypeLeftMouseDown, NSEventTypeLeftMouseUp}) {
    NSEvent *event = [NSEvent mouseEventWithType:type location:point modifierFlags:0
      timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
      context:nil eventNumber:0 clickCount:1 pressure:1];
    [NSApp postEvent:event atStart:NO];
  }
  napi_get_undefined(env, &result);
  return result;
}

struct WheelInput {
  double x, y, deltaX, deltaY;
  bool control, precise;
};

static id wheelMonitor;
static napi_threadsafe_function wheelCallback;

static void dispatchWheel(napi_env env, napi_value callback, void *, void *data) {
  auto *wheel = static_cast<WheelInput *>(data);
  if (env && callback) {
    napi_value record, value, context;
    napi_create_object(env, &record);
    for (auto [name, field] : {std::pair{"x", wheel->x}, {"y", wheel->y},
                              {"deltaX", wheel->deltaX}, {"deltaY", wheel->deltaY}}) {
      napi_create_double(env, field, &value);
      napi_set_named_property(env, record, name, value);
    }
    napi_get_boolean(env, wheel->control, &value);
    napi_set_named_property(env, record, "control", value);
    napi_get_boolean(env, wheel->precise, &value);
    napi_set_named_property(env, record, "precise", value);
    napi_get_undefined(env, &context);
    napi_call_function(env, context, callback, 1, &record, nullptr);
  }
  delete wheel;
}

static NSWindow *fixtureWindow(napi_env env, napi_value handle) {
  void *bytes = nullptr, *address = nullptr;
  size_t size = 0;
  if (napi_get_buffer_info(env, handle, &bytes, &size) != napi_ok || size != sizeof(void *))
    return nil;
  std::memcpy(&address, bytes, size);
  return ((__bridge NSView *)address).window;
}

static napi_value beginWheelRoute(napi_env env, napi_callback_info info) {
  napi_value args[2], name, value;
  size_t count = 2;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  NSWindow *window = count == 2 ? fixtureWindow(env, args[0]) : nil;
  if (!window || wheelMonitor) {
    napi_throw_error(env, nullptr, "Invalid wheel route or already installed");
    return nullptr;
  }
  napi_create_string_utf8(env, "wheel route", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, args[1], nullptr, name, 256, 1, nullptr, nullptr,
                                      nullptr, dispatchWheel, &wheelCallback) != napi_ok) {
    napi_throw_error(env, nullptr, "Could not initialize wheel route");
    return nullptr;
  }
  wheelMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskScrollWheel
    handler:^NSEvent *(NSEvent *event) {
      NSPoint location;
      if (event.window == window) {
        location = event.locationInWindow;
      } else if (!event.window && window.isKeyWindow) {
        location = [window convertPointFromScreen:event.locationInWindow];
      } else {
        return event;
      }
      const NSRect frame = window.contentView.frame;
      const double x = location.x - NSMinX(frame);
      const double y = NSMaxY(frame) - location.y;
      if (x < 160 || y < 80 || x >= NSWidth(frame) || y >= NSHeight(frame)) return event;
      auto *input = new WheelInput{x,y,event.scrollingDeltaX,event.scrollingDeltaY,
        (event.modifierFlags & NSEventModifierFlagControl) != 0, event.hasPreciseScrollingDeltas};
      if (napi_call_threadsafe_function(wheelCallback, input, napi_tsfn_nonblocking) == napi_ok)
        return nil;
      delete input;
      return event;
    }];
  napi_get_undefined(env, &value);
  return value;
}

static napi_value endWheelRoute(napi_env env, napi_callback_info) {
  if (wheelMonitor) {
    [NSEvent removeMonitor:wheelMonitor];
    wheelMonitor = nil;
    napi_release_threadsafe_function(wheelCallback, napi_tsfn_release);
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value queueWheel(napi_env env, napi_callback_info info) {
  napi_value args[6], value;
  size_t count = 6;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  NSWindow *window = count == 6 ? fixtureWindow(env, args[0]) : nil;
  double x, y;
  int32_t dx, dy;
  bool control;
  if (!window || !window.isVisible ||
      napi_get_value_double(env, args[1], &x) != napi_ok ||
      napi_get_value_double(env, args[2], &y) != napi_ok ||
      napi_get_value_int32(env, args[3], &dx) != napi_ok ||
      napi_get_value_int32(env, args[4], &dy) != napi_ok ||
      napi_get_value_bool(env, args[5], &control) != napi_ok) {
    napi_throw_error(env, nullptr, "Invalid local wheel input");
    return nullptr;
  }
  NSRect frame = window.contentView.frame;
  NSPoint point = [window convertPointToScreen:NSMakePoint(NSMinX(frame)+x, NSMaxY(frame)-y)];
  const CGRect primary = CGDisplayBounds(CGMainDisplayID());
  CGEventRef event = CGEventCreateScrollWheelEvent(nullptr, kCGScrollEventUnitPixel, 2, dy, dx);
  CGPoint location = CGPointMake(point.x, CGRectGetHeight(primary) - point.y);
  CGEventSetLocation(event, location);
  if (CGWarpMouseCursorPosition(location) != kCGErrorSuccess) {
    CFRelease(event);
    napi_throw_error(env, nullptr, "Failed to position the hosted test cursor");
    return nullptr;
  }
  CGEventSetIntegerValueField(event, kCGMouseEventWindowUnderMousePointer, window.windowNumber);
  CGEventSetIntegerValueField(event, kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent, window.windowNumber);
  CGEventSetFlags(event, control ? kCGEventFlagMaskControl : 0);
  const bool canPost = CGPreflightPostEventAccess();
  if (canPost) {
    CGEventPost(kCGSessionEventTap, event);
  } else {
    [NSApp postEvent:[NSEvent eventWithCGEvent:event] atStart:NO];
  }
  CFRelease(event);
  napi_get_boolean(env, canPost, &value);
  return value;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor items[] = {
    {"getHit", nullptr, getHit, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"queueClick", nullptr, queueClick, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"queueWheel", nullptr, queueWheel, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"beginWheelRoute", nullptr, beginWheelRoute, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"endWheelRoute", nullptr, endWheelRoute, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(items)/sizeof(items[0]), items);
  return exports;
}
