#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <node_api.h>
#include <cstring>
#include <initializer_list>

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

NAPI_MODULE_INIT() {
  napi_property_descriptor items[] = {
    {"getHit", nullptr, getHit, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"queueClick", nullptr, queueClick, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(items)/sizeof(items[0]), items);
  return exports;
}
