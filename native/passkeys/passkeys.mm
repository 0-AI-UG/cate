#import <AppKit/AppKit.h>
#import <AuthenticationServices/AuthenticationServices.h>
#import <Security/Security.h>
#include <node_api.h>
#include <string>

static NSData *decode(NSString *text) {
  NSString *base = [[text stringByReplacingOccurrencesOfString:@"-" withString:@"+"] stringByReplacingOccurrencesOfString:@"_" withString:@"/"];
  while (base.length % 4) base = [base stringByAppendingString:@"="];
  return [[NSData alloc] initWithBase64EncodedString:base options:0];
}
static NSString *encode(NSData *data) {
  return [[[[data base64EncodedStringWithOptions:0] stringByReplacingOccurrencesOfString:@"+" withString:@"-"] stringByReplacingOccurrencesOfString:@"/" withString:@"_"] stringByReplacingOccurrencesOfString:@"=" withString:@""] ?: @"";
}
static NSString *stringArgument(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length > 1048576) return nil;
  std::string buffer(length + 1, '\0');
  napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length);
  return [[NSString alloc] initWithBytes:buffer.data() length:length encoding:NSUTF8StringEncoding];
}
static bool available() {
  if (@available(macOS 14.4, *)) {
    SecTaskRef task = SecTaskCreateFromSelf(kCFAllocatorDefault);
    if (!task) return false;
    CFTypeRef entitlement = SecTaskCopyValueForEntitlement(task, CFSTR("com.apple.developer.web-browser.public-key-credential"), nullptr);
    bool enabled = entitlement && CFEqual(entitlement, kCFBooleanTrue);
    if (entitlement) CFRelease(entitlement);
    CFRelease(task);
    return enabled;
  }
  return false;
}

@interface CatePasskeyRequest : NSObject <ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding>
@property napi_env env;
@property napi_deferred deferred;
@property (strong) ASAuthorizationController *controller;
@property (strong) NSWindow *window;
@property (copy) NSString *identifier;
@property BOOL settled;
- (void)finish:(NSDictionary *)result;
@end
static CatePasskeyRequest *activeRequest;

@implementation CatePasskeyRequest
- (ASPresentationAnchor)presentationAnchorForAuthorizationController:(ASAuthorizationController *)controller { return self.window; }
- (void)finish:(NSDictionary *)result {
  if (self.settled) return;
  self.settled = YES;
  napi_handle_scope scope;
  napi_open_handle_scope(self.env, &scope);
  NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
  napi_value value;
  napi_create_string_utf8(self.env, (const char *)json.bytes, json.length, &value);
  napi_resolve_deferred(self.env, self.deferred, value);
  napi_close_handle_scope(self.env, scope);
  self.controller.delegate = nil;
  self.controller.presentationContextProvider = nil;
  self.controller = nil;
  if (activeRequest == self) activeRequest = nil;
}
- (void)authorizationController:(ASAuthorizationController *)controller didCompleteWithError:(NSError *)error {
  NSString *name = @"NotAllowedError";
  if (@available(macOS 15.0, *)) {
    if (error.code == ASAuthorizationErrorMatchedExcludedCredential) name = @"InvalidStateError";
  }
  [self finish:@{ @"error": name }];
}
- (void)authorizationController:(ASAuthorizationController *)controller didCompleteWithAuthorization:(ASAuthorization *)authorization {
  id credential = authorization.credential;
  if (![credential conformsToProtocol:@protocol(ASPublicKeyCredential)]) {
    [self finish:@{ @"error": @"NotAllowedError" }];
    return;
  }
  id<ASPublicKeyCredential> key = credential;
  BOOL platform = [credential isKindOfClass:[ASAuthorizationPlatformPublicKeyCredentialRegistration class]]
    || [credential isKindOfClass:[ASAuthorizationPlatformPublicKeyCredentialAssertion class]];
  // Apple's platform provider also returns credentials used from a nearby
  // phone. The provider class alone does not identify the attachment.
  NSString *attachment = @"cross-platform";
  if (@available(macOS 13.5, *)) {
    if ([credential isKindOfClass:[ASAuthorizationPlatformPublicKeyCredentialRegistration class]]) {
      attachment = [(ASAuthorizationPlatformPublicKeyCredentialRegistration *)credential attachment] == ASAuthorizationPublicKeyCredentialAttachmentPlatform ? @"platform" : @"cross-platform";
    } else if ([credential isKindOfClass:[ASAuthorizationPlatformPublicKeyCredentialAssertion class]]) {
      attachment = [(ASAuthorizationPlatformPublicKeyCredentialAssertion *)credential attachment] == ASAuthorizationPublicKeyCredentialAttachmentPlatform ? @"platform" : @"cross-platform";
    }
  }
  NSMutableDictionary *response = [@{ @"clientDataJSON": encode(key.rawClientDataJSON) } mutableCopy];
  NSMutableDictionary *extensions = [NSMutableDictionary dictionary];
  if ([credential conformsToProtocol:@protocol(ASAuthorizationPublicKeyCredentialRegistration)]) {
    response[@"attestationObject"] = encode([(id<ASAuthorizationPublicKeyCredentialRegistration>)credential rawAttestationObject]);
    if (platform) extensions[@"credProps"] = @{ @"rk": @YES };
  } else {
    id<ASAuthorizationPublicKeyCredentialAssertion> assertion = credential;
    response[@"authenticatorData"] = encode(assertion.rawAuthenticatorData);
    response[@"signature"] = encode(assertion.signature);
    response[@"userHandle"] = assertion.userID.length ? encode(assertion.userID) : [NSNull null];
  }
  [self finish:@{ @"id": encode(key.credentialID), @"rawId": encode(key.credentialID), @"type": @"public-key",
    @"authenticatorAttachment": attachment, @"response": response,
    @"clientExtensionResults": extensions }];
}
@end

static napi_value isAvailable(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_get_boolean(env, available(), &result);
  return result;
}

static napi_value request(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  NSString *text = argc == 2 ? stringArgument(env, argv[0]) : nil;
  void *handle = nullptr;
  size_t handleSize = 0;
  bool isBuffer = false;
  if (argc == 2) napi_is_buffer(env, argv[1], &isBuffer);
  if (isBuffer) napi_get_buffer_info(env, argv[1], &handle, &handleSize);
  NSDictionary *input = text ? [NSJSONSerialization JSONObjectWithData:[text dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil] : nil;
  if (![input isKindOfClass:[NSDictionary class]] || !handle || handleSize != sizeof(void *)) {
    napi_throw_type_error(env, nullptr, "Invalid native passkey request"); return nullptr;
  }
  napi_value promise;
  CatePasskeyRequest *pending = [CatePasskeyRequest new];
  pending.env = env;
  napi_deferred deferred;
  napi_create_promise(env, &deferred, &promise);
  pending.deferred = deferred;
  if (!available() || activeRequest) {
    [pending finish:@{ @"error": @"NotAllowedError" }]; return promise;
  }
  NSView *view = (__bridge NSView *)(*(void **)handle);
  pending.window = view.window;
  if (!pending.window || !pending.window.visible) {
    [pending finish:@{ @"error": @"NotAllowedError" }]; return promise;
  }
  pending.identifier = input[@"id"];
  activeRequest = pending;
  if (@available(macOS 14.4, *)) {
    @try {
      NSDictionary *options = input[@"options"];
      BOOL creating = [input[@"operation"] isEqual:@"create"];
      ASPublicKeyCredentialClientData *client = [[ASPublicKeyCredentialClientData alloc] initWithChallenge:decode(options[@"challenge"]) origin:input[@"origin"]];
      client.crossOrigin = ASPublicKeyCredentialClientDataCrossOriginValueSameOriginWithAncestors;
      NSString *rpId = options[@"rpId"];
      NSString *attachment = options[@"authenticatorSelection"][@"authenticatorAttachment"];
      NSMutableArray<ASAuthorizationRequest *> *requests = [NSMutableArray array];
      NSArray *descriptors = options[creating ? @"excludeCredentials" : @"allowCredentials"] ?: @[];
      NSMutableArray *platformDescriptors = [NSMutableArray array];
      NSMutableArray *securityDescriptors = [NSMutableArray array];
      for (NSDictionary *descriptor in descriptors) {
        [platformDescriptors addObject:[[ASAuthorizationPlatformPublicKeyCredentialDescriptor alloc] initWithCredentialID:decode(descriptor[@"id"])]];
        [securityDescriptors addObject:[[ASAuthorizationSecurityKeyPublicKeyCredentialDescriptor alloc] initWithCredentialID:decode(descriptor[@"id"]) transports:ASAuthorizationAllSupportedPublicKeyCredentialDescriptorTransports()]];
      }
      NSString *verification = (creating ? options[@"authenticatorSelection"][@"userVerification"] : options[@"userVerification"]) ?: @"preferred";
      if (![attachment isEqual:@"cross-platform"]) {
        ASAuthorizationPlatformPublicKeyCredentialProvider *provider = [[ASAuthorizationPlatformPublicKeyCredentialProvider alloc] initWithRelyingPartyIdentifier:rpId];
        if (creating) {
          BOOL supportsES256 = NO;
          for (NSDictionary *parameter in options[@"pubKeyCredParams"]) if ([parameter[@"alg"] integerValue] == -7) supportsES256 = YES;
          if (supportsES256) {
            ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest *r = [provider createCredentialRegistrationRequestWithClientData:client name:options[@"user"][@"name"] userID:decode(options[@"user"][@"id"])];
            r.displayName = options[@"user"][@"displayName"];
            r.excludedCredentials = platformDescriptors;
            r.userVerificationPreference = verification;
            r.attestationPreference = options[@"attestation"] ?: @"none";
            [requests addObject:r];
          }
        } else {
          ASAuthorizationPlatformPublicKeyCredentialAssertionRequest *r = [provider createCredentialAssertionRequestWithClientData:client];
          r.allowedCredentials = platformDescriptors;
          r.userVerificationPreference = verification;
          [requests addObject:r];
        }
      }
      if (![attachment isEqual:@"platform"]) {
        ASAuthorizationSecurityKeyPublicKeyCredentialProvider *provider = [[ASAuthorizationSecurityKeyPublicKeyCredentialProvider alloc] initWithRelyingPartyIdentifier:rpId];
        if (creating) {
          ASAuthorizationSecurityKeyPublicKeyCredentialRegistrationRequest *r = [provider createCredentialRegistrationRequestWithClientData:client displayName:options[@"user"][@"displayName"] name:options[@"user"][@"name"] userID:decode(options[@"user"][@"id"])];
          NSMutableArray *parameters = [NSMutableArray array];
          for (NSDictionary *p in options[@"pubKeyCredParams"]) [parameters addObject:[[ASAuthorizationPublicKeyCredentialParameters alloc] initWithAlgorithm:[p[@"alg"] integerValue]]];
          r.credentialParameters = parameters;
          r.excludedCredentials = securityDescriptors;
          r.userVerificationPreference = verification;
          r.residentKeyPreference = options[@"authenticatorSelection"][@"residentKey"] ?: ([options[@"authenticatorSelection"][@"requireResidentKey"] boolValue] ? @"required" : @"discouraged");
          r.attestationPreference = options[@"attestation"] ?: @"none";
          [requests addObject:r];
        } else {
          ASAuthorizationSecurityKeyPublicKeyCredentialAssertionRequest *r = [provider createCredentialAssertionRequestWithClientData:client];
          r.allowedCredentials = securityDescriptors;
          r.userVerificationPreference = verification;
          [requests addObject:r];
        }
      }
      if (!requests.count) { [pending finish:@{ @"error": @"NotSupportedError" }]; return promise; }
      void (^perform)(BOOL) = ^(BOOL platformAllowed) {
        if (pending.settled) return;
        NSMutableArray *allowed = [NSMutableArray array];
        for (ASAuthorizationRequest *r in requests) {
          BOOL platform = [r isKindOfClass:[ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest class]]
            || [r isKindOfClass:[ASAuthorizationPlatformPublicKeyCredentialAssertionRequest class]];
          if (!platform || platformAllowed) [allowed addObject:r];
        }
        if (!allowed.count) { [pending finish:@{ @"error": @"NotAllowedError" }]; return; }
        pending.controller = [[ASAuthorizationController alloc] initWithAuthorizationRequests:allowed];
        pending.controller.delegate = pending;
        pending.controller.presentationContextProvider = pending;
        // Default modal presentation keeps Apple's nearby-device QR fallback.
        // preferImmediatelyAvailableCredentials would suppress that fallback.
        [pending.controller performRequests];
      };
      ASAuthorizationWebBrowserPublicKeyCredentialManager *manager = [ASAuthorizationWebBrowserPublicKeyCredentialManager new];
      if (![attachment isEqual:@"cross-platform"] && manager.authorizationStateForPlatformCredentials == ASAuthorizationWebBrowserPublicKeyCredentialManagerAuthorizationStateNotDetermined) {
        [manager requestAuthorizationForPublicKeyCredentials:^(ASAuthorizationWebBrowserPublicKeyCredentialManagerAuthorizationState state) {
          dispatch_async(dispatch_get_main_queue(), ^{ perform(state == ASAuthorizationWebBrowserPublicKeyCredentialManagerAuthorizationStateAuthorized); });
        }];
      } else {
        perform(manager.authorizationStateForPlatformCredentials == ASAuthorizationWebBrowserPublicKeyCredentialManagerAuthorizationStateAuthorized);
      }
    } @catch (NSException *exception) {
      [pending finish:@{ @"error": @"NotAllowedError" }];
    }
  }
  return promise;
}

static napi_value cancel(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value value;
  napi_get_cb_info(env, info, &argc, &value, nullptr, nullptr);
  NSString *identifier = argc ? stringArgument(env, value) : nil;
  if (identifier && [activeRequest.identifier isEqual:identifier]) {
    CatePasskeyRequest *pending = activeRequest;
    [pending.controller cancel];
    [pending finish:@{ @"error": @"AbortError" }];
  }
  napi_get_undefined(env, &value);
  return value;
}
static void cleanup(void *context) {
  if (activeRequest && activeRequest.env == context) {
    activeRequest.settled = YES;
    activeRequest.controller.delegate = nil;
    activeRequest.controller.presentationContextProvider = nil;
    [activeRequest.controller cancel];
    activeRequest = nil;
  }
}
static napi_value init(napi_env env, napi_value exports) {
  napi_add_env_cleanup_hook(env, cleanup, env);
  napi_property_descriptor properties[] = {
    {"isAvailable", nullptr, isAvailable, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"request", nullptr, request, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"cancel", nullptr, cancel, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 3, properties);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
