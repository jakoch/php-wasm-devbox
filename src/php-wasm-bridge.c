/**
 * SPDX-FileCopyrightText: 2025 The PHP Foundation
 * SPDX-FileCopyrightText: 2023-2024 Antoine Bluchet
 * SPDX-FileCopyrightText: 2025 Jens A. Koch
 * SPDX-License-Identifier: MIT
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be included
 * in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 * OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
 * IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
 * CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 * TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

#include "sapi/embed/php_embed.h"
#include "main/php.h"
#include "main/php_main.h"
#include "main/php_output.h"
#include "main/php_variables.h"
#include "main/SAPI.h"

#include "Zend/zend.h"
#include "Zend/zend_API.h"
#include "Zend/zend_exceptions.h"
#include "Zend/zend_execute.h"
#include "Zend/zend_globals_macros.h"
#include "Zend/zend_interfaces.h"
#include "Zend/zend_string.h"
#include "Zend/zend_types.h"

#include <emscripten.h>
#include <stdlib.h>
#include <string.h>

/**
 * @brief PHP-WASM Bridge
 *
 * The PHP-WASM Bridge runs PHP inside a WebAssembly module built with
 * Emscripten and exposes it to JavaScript.
 *
 * Lifecycle
 * ---------
 * PHP's embed SAPI is not designed to be initialised and torn down around
 * every execution. `php_embed_init()` calls `sapi_startup()` -- which copies
 * the SAPI module and memsets the SAPI globals -- then `php_module_startup()`
 * and finally `php_request_startup()`. `php_embed_shutdown()` unwinds all
 * three. Calling that pair per execution is what the previous revision of
 * this file did, and it has two consequences:
 *
 *   1. Any request state established by the caller is wiped on every call,
 *      because `sapi_globals_ctor()` memsets `SG()`.
 *   2. `zval` and `zend_string` allocations made during the request are
 *      released by `php_request_shutdown()`, so a pointer into that memory
 *      must not outlive the call.
 *
 * The correct shape -- and the one used by seanmorris/php-wasm -- is to bring
 * the SAPI and module up exactly once, then run a normal
 * startup/execute/shutdown request cycle per execution:
 *
 *     phpw_init()            -> sapi_startup + module_startup  (once)
 *     phpw_request_begin()   -> php_request_startup()           (per execution)
 *     ... execute ...
 *     (internal)            -> php_request_shutdown()         (per execution)
 *
 * `phpw_exec()`, `phpw_run()` and `phpw()` drive that cycle themselves, so the
 * JavaScript-facing contract is unchanged.
 *
 * Returned strings
 * ----------------
 * `phpw_exec()` returns memory obtained from `malloc()`, not from PHP's
 * allocator, and the caller owns it. The string returned by
 * `zend_eval_string()` lives in the request and is destroyed by
 * `php_request_shutdown()`; returning that pointer directly was a
 * use-after-free. Use `phpw_free()` to release the result.
 *
 * Output
 * ------
 * Nothing is buffered. The embed SAPI writes straight to stdout, which reaches
 * JavaScript through the Emscripten `print:` module callback -- the mechanism
 * the playground relies on. Buffering here would swallow that output, so it is
 * deliberately absent.
 *
 * Errors
 * ------
 * Previously a parse error or an uncaught exception left `ret_zv`
 * uninitialised and the caller received whatever happened to be on the stack.
 * Failures are now reported through `phpw_last_error()` and, for
 * `phpw_exec()`, as a NULL return.
 *
 * Exported API
 * ------------
 *   phpw_init()                  - initialise PHP once
 *   phpw_destroy()               - release PHP entirely
 *   phpw_request_init(method, query_string, body) - set $_SERVER/$_GET/$_POST
 *   phpw_exec(code)     : string - evaluate an expression, return the result
 *   phpw_run(code)      : int    - execute a script, return an exit code
 *   phpw(file)          : int    - execute a file, return an exit code
 *   phpw_last_error()   : string - message of the last failure
 *   phpw_free(ptr)               - release a string from this API
 *   phpw_php_version()  : string - the PHP version this module was built with
 *
 * @see https://emscripten.org/docs/porting/connecting_cpp_and_javascript/Interacting-with-code.html
 */

/* Exit codes returned by phpw_run() and phpw(). */
#define PHPW_OK 0
#define PHPW_ERROR 1
#define PHPW_EXCEPTION 2
#define PHPW_NOT_INITIALISED 3

/* Guards the one-time SAPI/module startup. */
static int phpw_initialised = 0;

/* Guards the per-execution request cycle. */
static int phpw_request_active = 0;

static void phpw_request_begin(void);
static void phpw_request_end(void);

/* Error text for the most recent execution. */
static char *phpw_error_buf = NULL;

/* Request context supplied by the host, applied on the next request. */
static char *phpw_request_method = NULL;
static char *phpw_query_string = NULL;
static char *phpw_request_body = NULL;
/* strlen(phpw_request_body), kept so the read_post hook is O(1) per chunk. */
static size_t phpw_request_body_length = 0;
static char *phpw_content_type = NULL;
static char *phpw_script_name = NULL;
static char *phpw_request_uri = NULL;

/* Address handed to SG(server_context); see phpw_request_begin(). */
static int phpw_server_context_sentinel = 0;

/**
 * Copy a NUL-terminated string into memory the caller owns.
 *
 * Used for every pointer handed to JavaScript: PHP's allocator is scoped to the
 * request, so nothing allocated with emalloc/estrdup may escape it.
 */
static char *phpw_strdup(const char *src)
{
	size_t len;
	char *copy;

	if (src == NULL) {
		return NULL;
	}

	len = strlen(src);
	copy = (char *) malloc(len + 1);

	if (copy == NULL) {
		return NULL;
	}

	memcpy(copy, src, len + 1);

	return copy;
}

/** Replace a heap string, freeing the previous value. */
static void phpw_set(char **slot, const char *value)
{
	free(*slot);
	*slot = phpw_strdup(value);
}

/**
 * Push buffered stdout/stderr out to the JavaScript callbacks.
 *
 * The embed SAPI writes through stdio, which is line buffered, and the flush
 * that php_embed_shutdown() used to perform no longer happens because the
 * module stays initialised between executions. Without this, output surfaces
 * one execution late. The previous revision instead wrote a bare newline to
 * both streams to force a flush, which is why callers saw stray blank lines
 * between chunks; flushing directly avoids that.
 */
static void phpw_flush(void)
{
	/*
	 * PHP's output layer buffers independently of stdio and only flushes on a
	 * newline, so a script that writes without one would never reach ub_write.
	 * The previous revision relied on php_embed_shutdown() to force this out;
	 * since the module now stays initialised between executions it has to be
	 * explicit.
	 */
	php_output_flush_all();

	fflush(stdout);
	fflush(stderr);
}

/** Record a failure reason for retrieval via phpw_last_error(). */
static void phpw_set_error(const char *message)
{
	phpw_set(&phpw_error_buf, message);
}

/**
 * SAPI read_post hook: hand the caller's request body to PHP.
 *
 * This is the supported way to feed a request body to the embed SAPI, which
 * otherwise leaves read_post NULL and therefore always sees an empty body.
 *
 * It has to be a SAPI hook rather than a direct assignment to
 * SG(request_info).request_body because $_POST is built eagerly, not lazily:
 * php_request_startup() calls sapi_activate(), which runs
 * sapi_read_standard_form_data() to fill the body stream, and then
 * php_hash_environment() -> zend_activate_auto_globals(), which invokes the
 * non-JIT $_POST auto-global handler right there. Parsing therefore completes
 * before any code after php_request_startup() could install a stream, and it
 * also consumes SG(request_info).content_type_dup on the way.
 *
 * sapi_read_post_block() loops until this returns less than the buffer size,
 * so returning 0 once the body is exhausted terminates the read.
 */
static size_t phpw_read_post(char *buffer, size_t count_bytes)
{
	size_t consumed;

	if (phpw_request_body == NULL) {
		return 0;
	}

	/*
	 * SG(read_post_bytes) is maintained by sapi_read_post_block(), which adds
	 * exactly what this hook returns, and sapi_activate() resets it to 0 for
	 * every request. It therefore cannot exceed the body length, because we
	 * never return more than is left.
	 *
	 * The comparison below is unsigned, so clamp rather than rely on that
	 * staying true: an over-large SG(read_post_bytes) would wrap to a huge
	 * size_t and turn the memcpy into a heap overread of host-supplied data.
	 */
	consumed = (size_t) SG(read_post_bytes);

	if (consumed >= phpw_request_body_length) {
		return 0;
	}

	if (count_bytes > phpw_request_body_length - consumed) {
		count_bytes = phpw_request_body_length - consumed;
	}

	memcpy(buffer, phpw_request_body + consumed, count_bytes);

	return count_bytes;
}

/**
 * Initialise the SAPI and module. Safe to call repeatedly; only the first
 * call has an effect.
 */
int EMSCRIPTEN_KEEPALIVE phpw_init(void)
{
	if (phpw_initialised) {
		return PHPW_OK;
	}

	/*
	 * Disables the Zend memory manager. Required for a long-lived Wasm
	 * instance: its pools cannot be released back to the OS between requests
	 * and would otherwise accumulate until the module runs out of memory.
	 * Must be set before the first allocation, hence before php_embed_init().
	 */
	setenv("USE_ZEND_ALLOC", "0", 1);

	/*
	 * Install the body reader before startup. sapi_startup() copies the SAPI
	 * module struct, so patching it afterwards would have no effect.
	 */
	php_embed_module.read_post = phpw_read_post;

	if (php_embed_init(0, NULL) != SUCCESS) {
		phpw_set_error("php_embed_init() failed");
		return PHPW_ERROR;
	}

	/*
	 * php_embed_init() performs a php_request_startup() of its own, so a
	 * request is already active when it returns. Record that, otherwise the
	 * first phpw_request_begin() would not shut it down and every subsequent
	 * execution would stack another live request on top of it, leaking until
	 * the module runs out of memory.
	 */
	phpw_request_active = 1;
	phpw_initialised = 1;

	return PHPW_OK;
}

/** Tear down the SAPI and module. The module can be re-initialised after this. */
void EMSCRIPTEN_KEEPALIVE phpw_destroy(void)
{
	if (!phpw_initialised) {
		return;
	}

	/*
	 * php_embed_shutdown() closes a request unconditionally, because in the
	 * embed contract the one started by php_embed_init() is still open. This
	 * bridge closes the request after every execution, so there is normally
	 * none left and shutdown would run against torn-down state. Open one so
	 * that it has something to close, and deliberately leave it open: closing
	 * it here would only leave php_embed_shutdown() with a second, bogus
	 * shutdown to perform.
	 */
	if (!phpw_request_active) {
		SG(server_context) = &phpw_server_context_sentinel;
		SG(request_info).request_method = (char *) "GET";

		if (php_request_startup() == SUCCESS) {
			phpw_request_active = 1;
		}
	}

	php_embed_shutdown();
	phpw_initialised = 0;
}

/**
 * Publish one CGI-style entry into $_SERVER.
 *
 * The embed SAPI's register_variables handler is php_import_environment_variables(),
 * which copies the host process environment and nothing else. Unlike the CGI
 * SAPI it never sets REQUEST_METHOD, CONTENT_TYPE and friends, so a script that
 * inspects $_SERVER would otherwise see only the process environment.
 *
 * The auto-global handler for $_SERVER is invoked lazily, on first access, and
 * builds the array from scratch at that point. Writing into
 * PG(http_globals)[TRACK_VARS_SERVER] would therefore be discarded, so the
 * superglobal is materialised first and then updated in place.
 *
 * Note that php_register_variable_ex() must not be used for this: with a NULL
 * track_vars_array it takes an early "nothing to do" path that destroys the
 * zval it was handed, and with the superglobal passed in it takes ownership of
 * the value too. Either way a zval_ptr_dtor() by us is a double free.
 * zend_hash_str_update() is unambiguous -- the hash takes the zval.
 */
static void phpw_set_server_var(const char *name, const char *value)
{
	zval *server;
	zval entry;

	if (value == NULL) {
		return;
	}

	/* Triggers the auto-global handler, which populates $_SERVER. */
	zend_is_auto_global_str("_SERVER", sizeof("_SERVER") - 1);

	server = zend_hash_str_find(&EG(symbol_table), "_SERVER", sizeof("_SERVER") - 1);

	if (server == NULL || Z_TYPE_P(server) != IS_ARRAY) {
		return;
	}

	ZVAL_STRING(&entry, value);
	zend_hash_str_update(Z_ARRVAL_P(server), name, strlen(name), &entry);
}

/**
 * Start a request, applying any context set by phpw_request_init().
 *
 * Ordering matters here. php_request_startup() runs sapi_activate(), which
 * builds $_SERVER from SG(request_info).query_string via php_hash_environment()
 * and selects the POST handler from content_type -- so both must be set before
 * the call. sapi_activate() then *resets* SG(request_info).request_body to NULL
 * and SG(headers_sent) to 0, so the request body has to be installed after it.
 *
 * $_GET and $_POST themselves are populated lazily: the auto-global handlers
 * read SG(request_info) on first access, which happens while user code runs.
 */
static void phpw_request_begin(void)
{
	const char *method = phpw_request_method ? phpw_request_method : "GET";

	if (phpw_request_active) {
		/* Defensive: a leaked request would otherwise be shut down twice. */
		php_request_shutdown(NULL);
		phpw_request_active = 0;
	}

	/*
	 * sapi_activate() guards the whole POST-reading block on
	 * SG(server_context) being non-NULL, and nothing in the embed SAPI ever
	 * assigns it, so without this $_POST would always be empty. The pointer is
	 * only ever passed through to the SAPI callbacks, and the embed
	 * implementations of send_header()/flush() ignore the argument, so a
	 * sentinel that is never dereferenced is safe.
	 */
	SG(server_context) = &phpw_server_context_sentinel;

	SG(request_info).request_method = (char *) method;
	SG(request_info).query_string = phpw_query_string;
	SG(request_info).content_type = phpw_content_type;
	SG(request_info).content_length = phpw_request_body
		? (zend_long) strlen(phpw_request_body) : 0;

	if (php_request_startup() != SUCCESS) {
		phpw_set_error("php_request_startup() failed");
		return;
	}

	phpw_request_active = 1;

	phpw_set_server_var("REQUEST_METHOD", method);
	phpw_set_server_var("QUERY_STRING", phpw_query_string);
	phpw_set_server_var("CONTENT_TYPE", phpw_content_type);

	if (phpw_request_body != NULL) {
		char length[32];

		snprintf(length, sizeof(length), ZEND_LONG_FMT,
			(zend_long) strlen(phpw_request_body));
		phpw_set_server_var("CONTENT_LENGTH", length);
	}

	phpw_set_server_var("SCRIPT_NAME", phpw_script_name);
	phpw_set_server_var("REQUEST_URI", phpw_request_uri);

	/*
	 * Mirrors what php_embed_init() sets: the embed SAPI has no send-headers
	 * handler, so header emission must stay disabled.
	 */
	SG(request_info).no_headers = 1;
}

/** End the current request, if any. */
static void phpw_request_end(void)
{
	if (!phpw_request_active) {
		return;
	}

	php_request_shutdown(NULL);
	phpw_request_active = 0;
}

/**
 * Set the request context for the next execution.
 *
 * The strings are copied, so the caller may free them immediately. Pass NULL
 * for `method` to fall back to GET. `body` populates $_POST when the method is
 * POST and `content_type` names a handler the SAPI recognises, e.g.
 * "application/x-www-form-urlencoded" or "multipart/form-data".
 */
int EMSCRIPTEN_KEEPALIVE phpw_request_init(
	char *method, char *query_string, char *content_type, char *body,
	char *script_name, char *request_uri)
{
	if (phpw_init() != PHPW_OK) {
		return PHPW_ERROR;
	}

	phpw_set(&phpw_request_method, method);
	phpw_set(&phpw_query_string, query_string);
	phpw_set(&phpw_content_type, content_type);
	phpw_set(&phpw_request_body, body);
	phpw_set(&phpw_script_name, script_name);
	phpw_set(&phpw_request_uri, request_uri);

	/* Must stay in step with phpw_request_body; see phpw_read_post(). */
	phpw_request_body_length = body ? strlen(body) : 0;

	return PHPW_OK;
}

/**
 * Copy a zval string into a buffer the caller owns.
 *
 * The Z_STRVAL() of a request-scoped zval dies with the request, so anything
 * handed to JavaScript has to be duplicated out of it first.
 */
static char *phpw_dup_result(zval *result)
{
	char *copy;

	if (result == NULL || Z_TYPE_P(result) != IS_STRING) {
		return NULL;
	}

	copy = (char *) malloc(Z_STRLEN(*result) + 1);

	if (copy == NULL) {
		return NULL;
	}

	memcpy(copy, Z_STRVAL(*result), Z_STRLEN(*result) + 1);

	return copy;
}

/**
 * Evaluate a PHP expression and return its value as a string.
 *
 * Returns a buffer the caller must release with phpw_free(), or NULL when the
 * expression failed to compile or threw. Use phpw_last_error() for the reason.
 */
char *EMSCRIPTEN_KEEPALIVE phpw_exec(char *code)
{
	char *result = NULL;
	zval ret_zv;

	phpw_set_error(NULL);

	if (phpw_init() != PHPW_OK) {
		return NULL;
	}

	phpw_request_begin();

	if (!phpw_request_active) {
		return NULL;
	}

	ZVAL_UNDEF(&ret_zv);

	zend_first_try {
		if (zend_eval_string(code, &ret_zv, "expression") != SUCCESS) {
			/*
			 * Compilation failed, so ret_zv was never written. Reporting this
			 * explicitly is what keeps convert_to_string() away from an
			 * uninitialised zval.
			 */
			phpw_set_error("parse error in expression");
		} else if (EG(exception)) {
			zval rv;
			zval *message;

			/*
			 * Read the public "message" property rather than calling
			 * getMessage(): it needs no method lookup and cannot itself throw.
			 * silent=1 yields NULL when the property is absent. EG(exception)
			 * stays valid until zend_clear_exception() below, so the pointer
			 * is safe to read and copy here.
			 */
			message = zend_read_property(
				EG(exception)->ce, EG(exception), "message",
				sizeof("message") - 1, 1, &rv
			);

			if (message != NULL && Z_TYPE_P(message) == IS_STRING) {
				phpw_set_error(Z_STRVAL_P(message));
			} else {
				phpw_set_error("uncaught exception");
			}

			zend_clear_exception();
		} else {
			/*
			 * Coerce the result to a string. zend_eval_string() sets a return
			 * value of whatever type the expression produced, so without this
			 * an int, float, bool or array would come back empty.
			 *
			 * Safe only on the success path: on a compile failure ret_zv was
			 * never written and converting it would read an uninitialised zval.
			 */
			convert_to_string(&ret_zv);
		}
	} zend_catch {
		phpw_set_error("execution aborted");
	} zend_end_try();

	/*
	 * Copy out of the request before shutting it down. Z_STRVAL(ret_zv)
	 * points into memory that php_request_shutdown() is about to release.
	 */
	if (Z_TYPE(ret_zv) == IS_STRING) {
		result = phpw_dup_result(&ret_zv);
	}

	zval_ptr_dtor(&ret_zv);

	phpw_request_end();
	phpw_flush();

	return result;
}

/**
 * Execute a PHP script.
 *
 * Returns PHPW_OK, or one of the PHPW_* codes; phpw_last_error() carries the
 * detail.
 */
int EMSCRIPTEN_KEEPALIVE phpw_run(char *code)
{
	int status = PHPW_OK;
	zend_result compiled;

	phpw_set_error(NULL);

	if (phpw_init() != PHPW_OK) {
		return PHPW_ERROR;
	}

	phpw_request_begin();

	if (!phpw_request_active) {
		return PHPW_ERROR;
	}

	zend_first_try {
		compiled = zend_eval_string(code, NULL, "script");

		if (compiled != SUCCESS) {
			phpw_set_error("parse error in script");
			status = PHPW_ERROR;
		} else if (EG(exception)) {
			/*
			 * Report the exception through the configured error handler, which
			 * writes to stderr where the JavaScript side can observe it. A
			 * bailout (exit/die) is a normal outcome, not a failure.
			 */
			if (!zend_is_graceful_exit(EG(exception))
				&& !zend_is_unwind_exit(EG(exception))) {
				zend_exception_error(EG(exception), E_ERROR);
				status = PHPW_EXCEPTION;
			}
		}
	} zend_catch {
		phpw_set_error("execution aborted");
		status = PHPW_ERROR;
	} zend_end_try();

	phpw_request_end();
	phpw_flush();

	return status;
}

/**
 * Execute a PHP file.
 *
 * Returns PHPW_OK, or one of the PHPW_* codes; phpw_last_error() carries the
 * detail.
 */
int EMSCRIPTEN_KEEPALIVE phpw(char *file)
{
	int status = PHPW_OK;
	zend_file_handle file_handle;

	phpw_set_error(NULL);

	if (phpw_init() != PHPW_OK) {
		return PHPW_ERROR;
	}

	phpw_request_begin();

	if (!phpw_request_active) {
		return PHPW_ERROR;
	}

	zend_first_try {
		/*
		 * zend_stream_init_filename() is void in PHP 8.4: there is no failure
		 * return to test. A missing or unreadable script surfaces as a warning
		 * from the stream layer and php_execute_script() returning false.
		 */
		zend_stream_init_filename(&file_handle, file);
		file_handle.primary_script = 1;

		if (!php_execute_script(&file_handle)) {
			phpw_set_error("failed to execute script");
			status = PHPW_ERROR;
		} else if (EG(exception)) {
			phpw_set_error("script threw an uncaught exception");
			status = PHPW_EXCEPTION;
		}

		zend_destroy_file_handle(&file_handle);
	} zend_catch {
		phpw_set_error("execution aborted");
		status = PHPW_ERROR;
	} zend_end_try();

	phpw_request_end();
	phpw_flush();

	return status;
}

/** Message describing the most recent failure, or NULL if there was none. */
char *EMSCRIPTEN_KEEPALIVE phpw_last_error(void)
{
	return phpw_error_buf;
}

/** Release a string returned by this API. */
void EMSCRIPTEN_KEEPALIVE phpw_free(char *ptr)
{
	free(ptr);
}

/** The PHP version this module was compiled against. */
char *EMSCRIPTEN_KEEPALIVE phpw_php_version(void)
{
	return phpw_strdup(PHP_VERSION);
}

int main(int argc, char **argv)
{
	if (argc < 2) {
		fprintf(stderr, "usage: %s <script.php>\n", argv[0]);
		return PHPW_ERROR;
	}

	if (phpw_init() != PHPW_OK) {
		return PHPW_ERROR;
	}

	int status = phpw(argv[1]);

	phpw_destroy();

	return status;
}
