// The upstream invoicing assertions intentionally use English number grouping.
// Windows reports the machine locale to Node, so pin only omitted locales for
// reproducible test runs; explicit app/user locales still pass through.
const NativeNumberFormat = Intl.NumberFormat;
Intl.NumberFormat = new Proxy(NativeNumberFormat, {
  apply(target, thisArg, args) {
    if (args[0] === undefined || args[0] === null || args[0] === '') args[0] = 'en-US';
    return Reflect.apply(target, thisArg, args);
  },
  construct(target, args, newTarget) {
    if (args[0] === undefined || args[0] === null || args[0] === '') args[0] = 'en-US';
    return Reflect.construct(target, args, newTarget);
  },
});
const NativeDateTimeFormat = Intl.DateTimeFormat;
Intl.DateTimeFormat = new Proxy(NativeDateTimeFormat, {
  apply(target, thisArg, args) {
    if (args[0] === undefined || args[0] === null || args[0] === '') args[0] = 'en-US';
    return Reflect.apply(target, thisArg, args);
  },
  construct(target, args, newTarget) {
    if (args[0] === undefined || args[0] === null || args[0] === '') args[0] = 'en-US';
    return Reflect.construct(target, args, newTarget);
  },
});
for (const method of ['toLocaleDateString', 'toLocaleString', 'toLocaleTimeString']) {
  const native = Date.prototype[method];
  Date.prototype[method] = function (locales, ...args) {
    return native.call(this, locales || 'en-US', ...args);
  };
}
