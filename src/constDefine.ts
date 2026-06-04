export const P4LENS_EXTENSION_ID = 'p4LensLite';
export const P4LENS_LOG_PREFIX = '[P4Lens]';
export const P4_CONFIG_FILE_NAME = 'p4config.txt';

export const COMMAND_CHECK_OPEN_STATE_CACHE = 'p4lenslite.checkOpenStateCache';
export const COMMAND_COPY_CHANGELIST_NUMBER = 'p4lenslite.copyChangelistNumber';
export const COMMAND_NOOP_SYMBOL_CODELENS = 'p4lenslite.noopSymbolCodeLens';

export const CONFIG_KEY_OPEN_STATE_POLL_INTERVAL_SECONDS = 'openStatePollIntervalSeconds';
export const CONFIG_KEY_ENABLE_SYMBOL_CODELENS = 'enableSymbolCodeLens';

export const DESCRIPTION_TRACE_CONFIGURATION_PREFIX = 'p4LensLite.descriptionTrace';
export const DESCRIPTION_TRACE_ENABLED_CONFIG_KEY = 'descriptionTrace.enabled';
export const DESCRIPTION_TRACE_MARKER_CONFIG_KEY = 'descriptionTrace.marker';
export const DESCRIPTION_TRACE_PARSER_CONFIG_KEY = 'descriptionTrace.parser';
export const DESCRIPTION_TRACE_CHANGE_KEY_CONFIG_KEY = 'descriptionTrace.changeKey';
export const DESCRIPTION_TRACE_USER_KEY_CONFIG_KEY = 'descriptionTrace.userKey';
export const DESCRIPTION_TRACE_DESCRIPTION_KEY_CONFIG_KEY = 'descriptionTrace.descriptionKey';
export const DESCRIPTION_TRACE_STREAM_KEY_CONFIG_KEY = 'descriptionTrace.streamKey';
export const DESCRIPTION_TRACE_MAX_DEPTH_CONFIG_KEY = 'descriptionTrace.maxDepth';

export const DEFAULT_DESCRIPTION_TRACE_MARKER = 'source:';
export const DEFAULT_DESCRIPTION_TRACE_PARSER = 'json';
export const DEFAULT_DESCRIPTION_TRACE_CHANGE_KEY = 'changelist';
export const DEFAULT_DESCRIPTION_TRACE_USER_KEY = 'user';
export const DEFAULT_DESCRIPTION_TRACE_DESCRIPTION_KEY = 'description';
export const DEFAULT_DESCRIPTION_TRACE_STREAM_KEY = 'stream';

export const TEXT_NA = 'N/A';
export const TEXT_UNKNOWN = 'unknown';
export const TEXT_UNCOMMITTED = 'uncommitted';
export const TEXT_UNCOMMITTED_CHANGES = 'uncommitted changes';
export const TEXT_UNCOMMITTED_PARENS = '(uncommitted)';
export const TEXT_CURRENT_VERSION = 'Current Version';
export const TEXT_CONTRIBUTORS = 'Contributors:';
export const TEXT_STREAM = 'Stream:';
export const TEXT_SOURCE_CL = 'Source CL:';
export const TEXT_SOURCE_USER = 'Source User:';
export const TEXT_SOURCE_DESCRIPTION = 'Source Description:';
export const TEXT_UNRESOLVED_TRACE = 'Unable to resolve the traced changelist.';
export const TEXT_LINE = 'line';
export const TEXT_LINES = 'lines';
export const TEXT_SYMBOL_CLASS = 'Class';
export const TEXT_SYMBOL_INTERFACE = 'Interface';
export const TEXT_SYMBOL_STRUCT = 'Struct';
export const TEXT_SYMBOL_FUNCTION = 'Function';

export const TEMPLATE_COPY_CLIPBOARD_MESSAGE = 'Copied CL Number {0} to clipboard';
export const TEMPLATE_TRACE_VERSION_TITLE = 'Traced Version {0} (From Description)';
