/**
 * SPDX-FileCopyrightText: 2025 The PHP Foundation
 * SPDX-FileCopyrightText: 2023-2024 Antoine Bluchet
 * SPDX-FileCopyrightText: 2025 Jens A. Koch
 * SPDX-License-Identifier: MIT
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */

#include "sapi/embed/php_embed.h"
#include <emscripten.h>
#include <stdlib.h>

#include "zend_globals_macros.h"
#include "zend_exceptions.h"
#include "zend_closures.h"

/**
 * @brief PHP-WASM Bridge
 *
 * The PHP-WASM Bridge enables execution of PHP code in a WebAssembly environment.
 *
 * The bridge is built using Emscripten, which compiles the PHP interpreter into
 * a WebAssembly module. The resulting module contains both the PHP runtime and
 * the ability to execute PHP code from JavaScript.
 *
 * The PHP runtime is made available through the SAPI (Server Application
 * Programming Interface) layer, which provides an interface for embedding PHP
 * into other applications.
 * To enable JavaScript access to the PHP interpreter and runtime,
 * the PHP-WASM module compiles and exports the following API functions:
 *
 * 1. phpw_exec(string code): string - Evaluates a PHP expression and returns the result as a string.
 * 2. phpw_run(string code): void    - Executes PHP code without returning a value.
 * 3. phpw(string filePath): void    - Runs a PHP script from a file.
 *
 * @see https://emscripten.org/docs/porting/connecting_cpp_and_javascript/Interacting-with-code.html#interacting-with-code-ccall-cwrap
 */

int main() {
	return 0;
}

/**
 * @brief Execute a PHP expression and return the result as a string.
 *
 * @param code PHP code to execute
 * @return char*
 */
char* EMSCRIPTEN_KEEPALIVE phpw_exec(char *code)
{
	setenv("USE_ZEND_ALLOC", "0", 1);
	php_embed_init(0, NULL);
	char *retVal = NULL;

	zend_try
	{
		zval ret_zv;

		zend_eval_string(code, &ret_zv, "expression");
		convert_to_string(&ret_zv);

		retVal = Z_STRVAL(ret_zv);
	} zend_catch {
	} zend_end_try();

	fprintf(stdout, "\n");
	fprintf(stderr, "\n");

	php_embed_shutdown();

	return retVal;
}

/**
 * @brief Execute PHP code.
 *
 * @param code PHP code to execute
 * @return void
 */
void EMSCRIPTEN_KEEPALIVE phpw_run(char *code)
{
	setenv("USE_ZEND_ALLOC", "0", 1);
	php_embed_init(0, NULL);
	PG(during_request_startup) = 0;

	zend_try
	{
		zend_eval_string(code, NULL, "script");
		if (EG(exception)) {
			zend_exception_error(EG(exception), E_ERROR);
		}
	} zend_catch {
		// int exit_status = EG(exit_status);
	} zend_end_try();

	fprintf(stdout, "\n");
	fprintf(stderr, "\n");

	php_embed_shutdown();
}

int EMBED_SHUTDOWN = 1;

/**
 * @brief Execute PHP file.
 *
 * @param file PHP file to execute
 */
void phpw(char *file)
{
	setenv("USE_ZEND_ALLOC", "0", 1);
	if (EMBED_SHUTDOWN == 0) {
		php_embed_shutdown();
	}

	php_embed_init(0, NULL);
	EMBED_SHUTDOWN = 0;
	zend_first_try {
		zend_file_handle file_handle;
		zend_stream_init_filename(&file_handle, file);
		// file_handle.primary_script = 1;

		if (!php_execute_script(&file_handle)) {
			php_printf("Failed to execute PHP script.\n");
		}

		zend_destroy_file_handle(&file_handle);
	} zend_catch {
		// int exit_status = EG(exit_status);
	} zend_end_try();

	fprintf(stdout, "\n");
	fprintf(stderr, "\n");

	php_embed_shutdown();
	EMBED_SHUTDOWN = 1;
}
