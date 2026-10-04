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
#include "Zend/zend_ini.h"
#include "Zend/zend_interfaces.h"
#include "Zend/zend_string.h"
#include "Zend/zend_types.h"

#include <emscripten.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/**
 * @brief PHP-WASM Bridge: runs PHP inside an Emscripten module.
 *
 * Lifecycle: bring the SAPI up once and run a request cycle per execution, as
 * seanmorris/php-wasm does. Calling php_embed_init()/php_embed_shutdown() per
 * call instead memsets the SAPI globals and frees request-scoped allocations,
 * which wiped request state and dangled returned pointers.
 *
 * Returned strings are malloc'd rather than request-scoped; release them with
 * phpw_free(). Output is unbuffered: stdout reaches JS via Emscripten's `print:`.
 * Failures surface through phpw_last_error(), never as an uninitialised zval.
 *
 * Exported API
 *   phpw_init()                  - initialise PHP once
 *   phpw_destroy()               - release PHP entirely
 *   phpw_request_init(method, query_string, body) - set $_SERVER/$_GET/$_POST
 *   phpw_exec(code)     : string - evaluate an expression, return the result
 *   phpw_run(code)      : int    - execute a script, return an exit code
 *   phpw(file)          : int    - execute a file, return an exit code
 *   phpw_last_error()   : string - message of the last failure
 *   phpw_free(ptr)               - release a string from this API
 *   phpw_php_version()  : string - the PHP version this module was built with
 *   phpw_vld_config(active, execute, verbosity, dump_paths) : int
 *                      - drive VLD opcode dumping (see the function's own docs)
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
static int phpw_ini_set(const char *name, const char *value);
static void phpw_restore_sapi_name(void);

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
 * php_embed_shutdown() used to flush on its way out; since the module now stays
 * initialised between executions, that no longer happens and output arrives an
 * execution late.
 *
 * Must run before phpw_request_end(): php_request_shutdown() destroys the output
 * layer, so a flush afterwards has nothing left to push.
 */
static void phpw_flush(void)
{
	/* PHP's output layer flushes only on a newline, so a script that writes
	 * without one needs this to reach ub_write. */
	php_output_flush_all();

	fflush(stdout);
	fflush(stderr);

	/* Emscripten's TTY only calls Module.print when it sees a newline, so an
	 * unterminated write stayed in tty.output until the *next* run printed one.
	 * fsync() drains it via TTY.default_tty_ops.fsync(), without adding a byte. */
	(void) fsync(fileno(stdout));
	(void) fsync(fileno(stderr));
}

/** Record a failure reason for retrieval via phpw_last_error(). */
static void phpw_set_error(const char *message)
{
	phpw_set(&phpw_error_buf, message);
}

/**
 * SAPI read_post hook: hand the caller's request body to PHP.
 *
 * Must be a SAPI hook, not an assignment to SG(request_info).request_body:
 * $_POST is built eagerly inside php_request_startup(), so a stream installed
 * afterwards is already too late.
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
	 * SG(read_post_bytes) is maintained by sapi_read_post_block() and reset per
	 * request, so it cannot exceed the body length. Clamp anyway: the
	 * subtraction is unsigned, so an over-large value would overread the memcpy.
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

/* php_error_cb(), saved by phpw_init() before zend_error_cb is replaced. */
static void (*phpw_error_cb_previous)(int type, zend_string *file, uint32_t line, zend_string *message) = NULL;

/* The SAPI's own name, saved the first time phpw_error_cb() borrows it. */
static char *phpw_sapi_name = NULL;

/**
 * Put the SAPI's real name back.
 *
 * php_error_cb() borrows it, and a fatal error longjmps straight out of that
 * callback without unwinding through C, so the borrow cannot be undone there.
 * phpw_request_begin() and phpw_request_end() do it instead: nothing else runs
 * in between except phpw_flush().
 */
static void phpw_restore_sapi_name(void)
{
	if (phpw_sapi_name != NULL) {
		sapi_module.name = phpw_sapi_name;
		phpw_sapi_name = NULL;
	}
}

/**
 * php_error_cb() with the SAPI name borrowed, so diagnostics land on stderr.
 *
 * display_errors writes to stdout for every SAPI except cli/cgi/phpdbg, where
 * display_errors=stderr is honoured (the display branch of php_error_cb() in
 * main/main.c). So without this, a parse error, a fatal or a warning arrives
 * interleaved with the script's own stdout: the playground's Errors panel sat on
 * its "No Errors!" placeholder while a fatal error was rendered as program
 * output, and the two could not be told apart. Setting the INI alone does
 * nothing, because the gate is the name.
 *
 * The borrow lasts only for this callback on purpose: 43 places in the tree
 * compare sapi_module.name, and phar, session and libxml all behave differently
 * for "cli".
 */
static void phpw_error_cb(int type, zend_string *file, uint32_t line, zend_string *message)
{
	if (phpw_sapi_name == NULL) {
		phpw_sapi_name = sapi_module.name;
	}
	sapi_module.name = (char *) "cli";

	/*
	 * Set here rather than once at startup: PG(display_errors) is per-request
	 * state, and whatever the request cycle does to it, this is the moment the
	 * display branch reads. (Setting it in phpw_init() appeared to succeed and
	 * then read back as "1" on the next request.)
	 */
	phpw_ini_set("display_errors", "stderr");

	phpw_error_cb_previous(type, file, line, message);
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

	/* Must come after php_embed_init(), which installs php_error_cb. */
	phpw_error_cb_previous = zend_error_cb;
	zend_error_cb = phpw_error_cb;

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
	 * php_embed_shutdown() closes a request unconditionally, but this bridge
	 * closes it after every execution, so there is normally none left. Open one
	 * for it to close, and leave it open.
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

	phpw_restore_sapi_name();
}

/**
 * Publish one CGI-style entry into $_SERVER.
 *
 * The embed SAPI sets neither REQUEST_METHOD nor CONTENT_TYPE. The $_SERVER
 * handler is lazy and rebuilds the array on first access, so materialise it,
 * then update in place.
 *
 * Do not use php_register_variable_ex(): it takes ownership of the zval, so a
 * zval_ptr_dtor() on our side is a double free. zend_hash_str_update() is
 * unambiguous -- the hash takes the zval.
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
 * Ordering is load-bearing: sapi_activate() reads query_string and content_type,
 * then *resets* request_body and headers_sent, so those go in before the call and
 * the body after it. $_GET and $_POST are populated lazily, on first access.
 */
static void phpw_request_begin(void)
{
	const char *method = phpw_request_method ? phpw_request_method : "GET";

	/* A fatal error in an earlier request may have left the SAPI name borrowed. */
	phpw_restore_sapi_name();

	if (phpw_request_active) {
		/* Defensive: a leaked request would otherwise be shut down twice. */
		php_request_shutdown(NULL);
		phpw_request_active = 0;
	}

	/*
	 * sapi_activate() guards POST reading on SG(server_context) being non-NULL
	 * and the embed SAPI never sets it, so without this $_POST is always empty.
	 * The embed send_header()/flush() ignore the argument, so a sentinel is safe.
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

	phpw_restore_sapi_name();
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
 * Coerce an evaluated result to a string in place.
 *
 * convert_to_string() throws for an object with no __toString, and that throw
 * is a bailout inside phpw_exec(), so the caller would only see "execution
 * aborted". Cast here instead, as zend_operators.c does. On failure the zval
 * stays unconverted, so phpw_exec() returns NULL.
 */
static void phpw_cast_result_to_string(zval *zv)
{
	char message[256];
	zval cast;

	if (Z_TYPE_P(zv) != IS_OBJECT) {
		convert_to_string(zv);
		return;
	}

	if (Z_OBJ_HT_P(zv)->cast_object(Z_OBJ_P(zv), &cast, IS_STRING) == SUCCESS) {
		zval_ptr_dtor(zv);
		ZVAL_COPY_VALUE(zv, &cast);
		return;
	}

	/* zend_std_cast_object_tostring() raises; take it back before reporting. */
	if (EG(exception)) {
		zend_clear_exception();
	}

	snprintf(message, sizeof(message),
		"Object of class %s could not be converted to string",
		ZSTR_VAL(Z_OBJCE_P(zv)->name));

	phpw_set_error(message);
}

/**
 * Evaluate a PHP expression and return its value as a string.
 *
 * Evaluates a single expression, per zend_eval_string(): the first statement's
 * value is the result, so `$a = 1; $a + 1;` gives "1". Wrap several statements
 * in an IIFE, as seanmorris/php-wasm documents for pib_exec(); for whole scripts
 * use phpw_run().
 *
 * Returns a buffer the caller must release with phpw_free(), or NULL on failure,
 * with the reason from phpw_last_error().
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
			 * Safe only on the success path: on a compile failure ret_zv was
			 * never written and converting it would read an uninitialised zval.
			 */
			phpw_cast_result_to_string(&ret_zv);
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

	/* While the request is still live: see phpw_flush(). */
	phpw_flush();
	phpw_request_end();

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

	/* While the request is still live: see phpw_flush(). */
	phpw_flush();
	phpw_request_end();

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

	/* While the request is still live: see phpw_flush(). */
	phpw_flush();
	phpw_request_end();

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

/**
 * Render a small integer as a NUL-terminated string.
 *
 * vld.verbosity is an OnUpdateLong directive taking 0-3. Formatting it with a
 * two-byte buffer, the way a boolean would be, turns a request for 3 into 1
 * without reporting anything, so the conversion is spelled out instead.
 *
 * @param value    Integer to render
 * @param buf      Destination buffer
 * @param buf_len  Size of the destination buffer
 */
static void phpw_vld_int_str(int value, char *buf, size_t buf_len)
{
	snprintf(buf, buf_len, "%d", value);
}

/**
 * Set one PHP_INI_SYSTEM directive from C.
 *
 * @param name   Directive name, e.g. "vld.active"
 * @param value  New value
 * @return PHPW_OK on success, PHPW_ERROR if the directive is unknown or refused
 */
static int phpw_ini_set(const char *name, const char *value)
{
	zend_string *key;
	zend_result result;

	key = zend_string_init(name, strlen(name), 1);

	if (key == NULL) {
		return PHPW_ERROR;
	}

	result = zend_alter_ini_entry_chars(
		key,
		value,
		strlen(value),
		ZEND_INI_SYSTEM,
		ZEND_INI_STAGE_ACTIVATE
	);

	zend_string_release(key);

	return result == SUCCESS ? PHPW_OK : PHPW_ERROR;
}

/**
 * Apply the four VLD directives that drive opcode dumping.
 *
 * @param active      Non-zero to install VLD's compiler hooks on request init
 * @param execute     Zero to replace the executor with a no-op (compile only)
 * @param verbosity   0-3; higher dumps more, see VLD's documentation
 * @param dump_paths  Non-zero to emit branch analysis alongside the opcodes
 * @return PHPW_OK on success, PHPW_ERROR if any directive is refused
 */
static int phpw_vld_apply(int active, int execute, int verbosity, int dump_paths)
{
	char verbosity_buf[12];

	phpw_vld_int_str(verbosity, verbosity_buf, sizeof(verbosity_buf));

	if (phpw_ini_set("vld.active", active ? "1" : "0") != PHPW_OK
		|| phpw_ini_set("vld.execute", execute ? "1" : "0") != PHPW_OK
		|| phpw_ini_set("vld.verbosity", verbosity_buf) != PHPW_OK
		|| phpw_ini_set("vld.dump_paths", dump_paths ? "1" : "0") != PHPW_OK) {
		/*
		 * A single missing directive means this build has no VLD, or an
		 * incompatible one. Say so, rather than letting the caller see an empty
		 * dump and wonder why.
		 */
		phpw_set_error("could not set VLD INI directives; is the extension present?");

		return PHPW_ERROR;
	}

	return PHPW_OK;
}

/**
 * Set the VLD INI directives that drive opcode dumping.
 *
 * Every directive here is declared PHP_INI_SYSTEM by the extension, so ini_set()
 * from userland is refused. C is not: zend_alter_ini_entry_ex() carries an
 * explicit special case for stage ZEND_INI_STAGE_ACTIVATE with modify_type
 * ZEND_INI_SYSTEM (Zend/zend_ini.c), which is the same pair
 * php_ini_activate_per_dir_config() uses. That is what lets the playground turn
 * dumping on and off between requests without restarting the module.
 *
 * The caller is expected to run a compile-only pass while dumping is active
 * (vld.active=1, vld.execute=0). VLD installs a no-op zend_execute_ex in that
 * combination, so the snippet is compiled and dumped but never executed, and its
 * output cannot mix with the script's stdout/stderr.
 *
 * @param active      Non-zero to install VLD's compiler hooks on request init
 * @param execute     Zero to replace the executor with a no-op (compile only)
 * @param verbosity   0-3; higher dumps more, see VLD's documentation
 * @param dump_paths  Non-zero to emit branch analysis alongside the opcodes
 * @return PHPW_OK on success, PHPW_ERROR on failure
 *
 * @see https://github.com/derickr/vld
 */
int EMSCRIPTEN_KEEPALIVE phpw_vld_config(int active, int execute, int verbosity, int dump_paths)
{
	/*
	 * The directives are looked up in EG(ini_directives), which php_embed_init()
	 * populates. A call made before the module is up therefore finds nothing and
	 * would return FAILURE for all four. phpw_init() is idempotent, so calling it
	 * here closes that hole without side effects.
	 */
	if (phpw_init() != PHPW_OK) {
		return PHPW_ERROR;
	}

	/*
	 * php_embed_init() opens a request of its own and leaves it open, so on the
	 * first call after startup there is already a live request here. Altering INI
	 * is only unsafe while a request owns CG()/EG(), and no caller can be
	 * mid-script: every entry point runs a whole request of its own and closes it
	 * again. Close the leftover rather than refusing.
	 *
	 * Refusing instead is silently fatal. It made the first phpw_vld_config()
	 * after startup do nothing at all, so the first dump came back empty with
	 * PHPW_OK never returned to warn anyone -- and because it also left vld.execute
	 * at 0, the next ordinary run had its executor replaced by VLD's no-op and
	 * produced no output either.
	 */
	phpw_request_end();

	if (verbosity < 0 || verbosity > 3) {
		phpw_set_error("verbosity must be between 0 and 3");
		return PHPW_ERROR;
	}

	return phpw_vld_apply(active, execute, verbosity, dump_paths);
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
